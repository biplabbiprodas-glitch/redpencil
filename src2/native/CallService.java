package com.redpencil.phone;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Foreground service that keeps Redpencil Phone awake and reachable.
 *
 * While the app screen is alive, the app itself listens for calls. If the app screen goes to sleep,
 * is swiped away, or hasn't been opened since an update or a restart, this service takes over:
 * it keeps the phone marked online and checks for incoming calls itself, then rings the phone
 * and opens the app when someone calls.
 */
public class CallService extends Service {
    public static final int NOTIF_ID = 1001;
    static final String PREFS = "rp_native";
    static final long JS_STALE_MS = 100_000;      // app screen counts as asleep after this long without a heartbeat
    static volatile long lastJsBeat = 0;
    static volatile boolean inCallNow = false;

    private PowerManager.WakeLock wake;
    private Thread watcher;
    private volatile boolean running = false;
    private final Set<String> seen = new HashSet<>();
    private String ringingId = null;

    public static void start(Context ctx, boolean inCall) {
        Intent i = new Intent(ctx, CallService.class);
        i.putExtra("inCall", inCall);
        ContextCompat.startForegroundService(ctx, i);
    }

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static boolean signedIn(Context c) { return prefs(c).getString("uid", "").length() > 0; }

    private Notification buildNotif(boolean inCall) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, RPNativePlugin.CH_SERVICE)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(inCall ? "Redpencil Phone — call in progress" : "Redpencil Phone is online")
            .setContentText(inCall ? "Tap to return to the call" : "Ready to receive calls and messages")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pi)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        RPNativePlugin.createChannels(this);
        boolean inCall = intent != null && intent.getBooleanExtra("inCall", false);
        inCallNow = inCall;
        Notification n = buildNotif(inCall);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                if (inCall) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                startForeground(NOTIF_ID, n, type);
            } else if (Build.VERSION.SDK_INT >= 30 && inCall) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            // e.g. microphone permission not granted yet: fall back to the plain "stay online" type
            try {
                if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                else startForeground(NOTIF_ID, n);
            } catch (Exception e2) { stopSelf(); return START_NOT_STICKY; }
        }
        // Keep the processor awake so the phone never drops off the network while the screen is off.
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "redpencil:online");
            wake.setReferenceCounted(false);
        }
        if (!wake.isHeld()) wake.acquire();
        startWatcher();
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app screen was swiped away. Stay online: this service keeps watching for calls
        // and reopens the app when someone calls.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (watcher != null) watcher.interrupt();
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------------ call watcher
    private synchronized void startWatcher() {
        if (watcher != null && watcher.isAlive()) return;
        running = true;
        watcher = new Thread(this::loop, "rp-watcher");
        watcher.start();
    }

    private void loop() {
        long lastBeat = 0;
        while (running) {
            long wait = 8000;
            try {
                // The app screen only counts as listening while it is actually on screen.
                // As soon as it goes to the background or the screen turns off, this service takes over.
                boolean jsAlive = RPNativePlugin.foreground && RPNativePlugin.instance != null
                    && System.currentTimeMillis() - lastJsBeat < JS_STALE_MS;
                if (signedIn(this) && !inCallNow) {
                    if (ringingId != null) {
                        checkRinging();
                        wait = 3000;
                    } else if (!jsAlive) {
                        if (System.currentTimeMillis() - lastBeat > 60_000) { heartbeat(); lastBeat = System.currentTimeMillis(); }
                        pollCalls();
                        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                        wait = pm.isInteractive() ? 6000 : 10000;
                    }
                }
            } catch (Exception ignored) {
                wait = 15000; // offline or token problem: try again a bit later
            }
            try { Thread.sleep(wait); } catch (InterruptedException e) { return; }
        }
    }

    private void pollCalls() throws Exception {
        SharedPreferences p = prefs(this);
        String uid = p.getString("uid", "");
        JSONObject q = new JSONObject("{\"structuredQuery\":{\"from\":[{\"collectionId\":\"calls\"}],\"where\":{\"compositeFilter\":{\"op\":\"AND\",\"filters\":["
            + "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"callee\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":" + JSONObject.quote(uid) + "}}},"
            + "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"status\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"ringing\"}}}]}},\"limit\":5}}");
        String res = Fs.http(this, "POST", Fs.docsBase(this) + ":runQuery", q.toString());
        JSONArray arr = new JSONArray(res);
        for (int i = 0; i < arr.length(); i++) {
            JSONObject row = arr.getJSONObject(i);
            if (!row.has("document")) continue;
            JSONObject doc = row.getJSONObject("document");
            String name = doc.getString("name");
            String id = name.substring(name.lastIndexOf('/') + 1);
            if (seen.contains(id)) continue;
            seen.add(id);
            long created = parseTime(doc.optString("createTime", ""));
            long now = parseTime(row.optString("readTime", ""));
            if (created > 0 && now > 0 && now - created > 45_000) continue; // an old, stale call
            JSONObject f = doc.getJSONObject("fields");
            String caller = str(f, "callerName", "Colleague");
            String ext = str(f, "callerExt", "");
            boolean video = f.has("video") && f.getJSONObject("video").optBoolean("booleanValue", false);
            ringingId = id;
            markDelivered(id);
            RPNativePlugin.postIncoming(this, caller, (video ? "Video call" : "Voice call") + (ext.isEmpty() ? "" : " · Ext " + ext), id);
            return;
        }
    }

    private void checkRinging() throws Exception {
        String id = ringingId;
        if (id == null) return;
        // the app screen is open again and has taken over the call
        if (RPNativePlugin.foreground && System.currentTimeMillis() - lastJsBeat < 8000) { ringingId = null; return; }
        JSONObject doc = new JSONObject(Fs.http(this, "GET", Fs.docsBase(this) + "/calls/" + id, null));
        String status = str(doc.getJSONObject("fields"), "status", "");
        if (!"ringing".equals(status)) {
            ringingId = null;
            NotificationManagerCompat.from(this).cancel(RPNativePlugin.NOTIF_INCOMING);
            if (!"accepted".equals(status)) RPNativePlugin.postMissed(this, str(doc.getJSONObject("fields"), "callerName", "Colleague"));
        }
    }

    private void heartbeat() throws Exception {
        String uid = prefs(this).getString("uid", "");
        JSONObject w = new JSONObject();
        String ver = "?";
        try { ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) {}
        w.put("update", new JSONObject().put("name", Fs.docName(this, "users/" + uid))
            .put("fields", new JSONObject()
                .put("online", new JSONObject().put("booleanValue", true))
                .put("appVersion", new JSONObject().put("stringValue", "Android " + ver))));
        w.put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("online").put("appVersion")));
        w.put("updateTransforms", new JSONArray()
            .put(new JSONObject().put("fieldPath", "lastSeen").put("setToServerValue", "REQUEST_TIME"))
            .put(new JSONObject().put("fieldPath", "backgroundSeen").put("setToServerValue", "REQUEST_TIME")));
        w.put("currentDocument", new JSONObject().put("exists", true));
        Fs.http(this, "POST", Fs.docsBase(this) + ":commit", new JSONObject().put("writes", new JSONArray().put(w)).toString());
    }

    private void markDelivered(String id) {
        try {
            JSONObject w = new JSONObject();
            w.put("transform", new JSONObject().put("document", Fs.docName(this, "calls/" + id))
                .put("fieldTransforms", new JSONArray().put(new JSONObject().put("fieldPath", "delivered").put("setToServerValue", "REQUEST_TIME"))));
            Fs.http(this, "POST", Fs.docsBase(this) + ":commit", new JSONObject().put("writes", new JSONArray().put(w)).toString());
        } catch (Exception ignored) {}
    }

    /** Decline a call from the notification even when the app screen isn't running. */
    static void declineCall(Context ctx, String id) {
        if (id == null || id.isEmpty()) return;
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try {
                JSONObject w = new JSONObject();
                w.put("update", new JSONObject().put("name", Fs.docName(app, "calls/" + id))
                    .put("fields", new JSONObject().put("status", new JSONObject().put("stringValue", "rejected"))));
                w.put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("status")));
                w.put("currentDocument", new JSONObject().put("exists", true));
                Fs.http(app, "POST", Fs.docsBase(app) + ":commit", new JSONObject().put("writes", new JSONArray().put(w)).toString());
            } catch (Exception ignored) {}
        }).start();
    }

    private static String str(JSONObject fields, String key, String def) {
        JSONObject v = fields.optJSONObject(key);
        return v == null ? def : v.optString("stringValue", def);
    }

    private static long parseTime(String iso) {
        try {
            if (iso == null || iso.length() < 19) return 0;
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return f.parse(iso.substring(0, 19)).getTime();
        } catch (Exception e) { return 0; }
    }
}
