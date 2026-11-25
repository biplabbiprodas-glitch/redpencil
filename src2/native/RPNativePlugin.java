package com.redpencil.phone;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "RPNative")
public class RPNativePlugin extends Plugin {
    public static final String CH_CALLS = "rp_calls_v2";
    public static final String CH_MSGS = "rp_messages";
    public static final String CH_SERVICE = "rp_service";
    public static final int NOTIF_INCOMING = 2001;
    public static RPNativePlugin instance;
    public static boolean foreground = true;
    public static String pendingAction = null;

    @Override
    public void load() {
        instance = this;
        createChannels(getContext());
        if (pendingAction != null) { dispatchAction(pendingAction); pendingAction = null; }
    }

    @Override
    protected void handleOnResume() {
        foreground = true;
        JSObject o = new JSObject(); o.put("state", "foreground");
        notifyListeners("appState", o);
    }

    @Override
    protected void handleOnPause() {
        foreground = false;
        JSObject o = new JSObject(); o.put("state", "background");
        notifyListeners("appState", o);
    }

    public void dispatchAction(String action) {
        JSObject o = new JSObject(); o.put("action", action);
        notifyListeners("callAction", o, true);
    }

    public static void createChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Rings when a colleague calls you");
        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes aa = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        calls.setSound(ring, aa);
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[]{0, 700, 400, 700});
        calls.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(calls);
        NotificationChannel msgs = new NotificationChannel(CH_MSGS, "Messages", NotificationManager.IMPORTANCE_HIGH);
        msgs.setDescription("New chat messages and files");
        nm.createNotificationChannel(msgs);
        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Stay online", NotificationManager.IMPORTANCE_LOW);
        svc.setDescription("Keeps Redpencil Phone connected so calls can reach you");
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);
    }

    private PendingIntent activityIntent(String action, int req) {
        Intent i = new Intent(getContext(), MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        if (action != null) i.putExtra("rp_action", action);
        return PendingIntent.getActivity(getContext(), req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Activity act = getActivity();
        if (Build.VERSION.SDK_INT >= 33 && act != null &&
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(act, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7001);
        }
        try {
            CallService.start(getContext(), false);
        } catch (Exception e) {
            call.reject("service: " + e.getMessage());
            return;
        }
        call.resolve(statusObj());
    }

    @PluginMethod
    public void callActive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try { CallService.start(getContext(), on); } catch (Exception ignored) {}
        if (!on && getActivity() instanceof MainActivity) {
            final MainActivity m = (MainActivity) getActivity();
            m.runOnUiThread(() -> m.showOverLock(false));
        }
        call.resolve();
    }

    private JSObject statusObj() {
        JSObject o = new JSObject();
        Context c = getContext();
        o.put("notifications", NotificationManagerCompat.from(c).areNotificationsEnabled());
        boolean fsi = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            fsi = nm.canUseFullScreenIntent();
        }
        o.put("fullScreen", fsi);
        boolean batt = true;
        if (Build.VERSION.SDK_INT >= 23) {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            batt = pm.isIgnoringBatteryOptimizations(c.getPackageName());
        }
        o.put("battery", batt);
        o.put("native", true);
        return o;
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(statusObj()); }

    @PluginMethod
    public void openSetting(PluginCall call) {
        String which = call.getString("which", "app");
        Context c = getContext();
        Intent i;
        try {
            if ("battery".equals(which) && Build.VERSION.SDK_INT >= 23) {
                i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + c.getPackageName()));
            } else if ("fullscreen".equals(which) && Build.VERSION.SDK_INT >= 34) {
                i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + c.getPackageName()));
            } else if ("notifications".equals(which) && Build.VERSION.SDK_INT >= 26) {
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
            } else {
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName()));
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception e) {
            Intent j = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName()));
            j.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(j);
        }
        call.resolve();
    }

    @PluginMethod
    public void showIncoming(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean screenOn = pm.isInteractive();
        if (foreground && screenOn) { JSObject r = new JSObject(); r.put("native", false); call.resolve(r); return; }
        String name = call.getString("name", "Colleague");
        String sub = call.getString("sub", "Redpencil Phone");
        Intent decl = new Intent(getContext(), CallActionReceiver.class);
        decl.setAction("com.redpencil.phone.DECLINE");
        PendingIntent declPi = PendingIntent.getBroadcast(getContext(), 11, decl, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CH_CALLS)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("Incoming call — " + name)
            .setContentText(sub)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(50000)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            .setVibrate(new long[]{0, 700, 400, 700})
            .setContentIntent(activityIntent("incoming", 12))
            .setFullScreenIntent(activityIntent("incoming", 13), true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", declPi)
            .addAction(android.R.drawable.sym_action_call, "Answer", activityIntent("answer", 14));
        android.app.Notification n = b.build();
        n.flags |= android.app.Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(getContext()).notify(NOTIF_INCOMING, n);
        } catch (SecurityException e) {
            JSObject r = new JSObject(); r.put("native", false); call.resolve(r); return;
        }
        JSObject r = new JSObject(); r.put("native", true); call.resolve(r);
    }

    @PluginMethod
    public void cancelIncoming(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(NOTIF_INCOMING);
        call.resolve();
    }

    @PluginMethod
    public void notifyMessage(PluginCall call) {
        if (foreground) { call.resolve(); return; }
        String title = call.getString("title", "New message");
        String body = call.getString("body", "");
        int id = 3000 + Math.abs(call.getString("tag", "x").hashCode() % 500);
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CH_MSGS)
            .setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(activityIntent("chat:" + call.getString("tag", ""), id));
        try { NotificationManagerCompat.from(getContext()).notify(id, b.build()); } catch (SecurityException ignored) {}
        call.resolve();
    }

    // ---- File saving (chunked, base64) ----
    private File tmpFile(String id) { return new File(getContext().getCacheDir(), "rpdl_" + id.replaceAll("[^A-Za-z0-9_-]", "")); }

    @PluginMethod
    public void fileChunk(PluginCall call) {
        String id = call.getString("id", "x");
        String data = call.getString("data", "");
        boolean first = Boolean.TRUE.equals(call.getBoolean("first", false));
        try (FileOutputStream fos = new FileOutputStream(tmpFile(id), !first)) {
            fos.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) { call.reject("write failed: " + e.getMessage()); }
    }

    @PluginMethod
    public void fileFinish(PluginCall call) {
        String id = call.getString("id", "x");
        String name = call.getString("name", "file").replaceAll("[\\\\/:*?\"<>|]", "_");
        String mime = call.getString("mime", "application/octet-stream");
        File src = tmpFile(id);
        try {
            Uri uri;
            String where;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Redpencil");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("could not create file");
                try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(uri)) {
                    byte[] buf = new byte[65536]; int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                v.clear(); v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, v, null, null);
                src.delete();
                where = "Downloads/Redpencil";
            } else {
                File dir = new File(getContext().getCacheDir(), "received");
                dir.mkdirs();
                File dst = new File(dir, name);
                if (!src.renameTo(dst)) throw new Exception("could not store file");
                uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", dst);
                where = "app storage";
            }
            JSObject r = new JSObject(); r.put("uri", uri.toString()); r.put("where", where);
            call.resolve(r);
        } catch (Exception e) { call.reject("save failed: " + e.getMessage()); }
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String u = call.getString("uri");
        String mime = call.getString("mime", "*/*");
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(u), mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            Intent chooser = Intent.createChooser(i, "Open with");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (ActivityNotFoundException e) { call.reject("No app can open this file"); }
        catch (Exception e) { call.reject(e.getMessage()); }
    }
}
