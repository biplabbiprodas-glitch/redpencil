package com.redpencil.phone;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

/** Foreground service that keeps Redpencil Phone connected while it is in the background. */
public class CallService extends Service {
    public static final int NOTIF_ID = 1001;

    public static void start(Context ctx, boolean inCall) {
        Intent i = new Intent(ctx, CallService.class);
        i.putExtra("inCall", inCall);
        ContextCompat.startForegroundService(ctx, i);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        RPNativePlugin.createChannels(this);
        boolean inCall = intent != null && intent.getBooleanExtra("inCall", false);
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, RPNativePlugin.CH_SERVICE)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(inCall ? "Redpencil Phone — call in progress" : "Redpencil Phone is online")
            .setContentText(inCall ? "Tap to return to the call" : "Ready to receive calls and messages")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pi)
            .build();
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
            } catch (Exception e2) { stopSelf(); }
        }
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app screen was swiped away: calls can't reach this phone until it is reopened.
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, RPNativePlugin.CH_MSGS)
            .setSmallIcon(android.R.drawable.stat_notify_missed_call)
            .setContentTitle("Redpencil Phone was closed")
            .setContentText("Tap to reopen so colleagues can call you")
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build();
        try { NotificationManagerCompat.from(this).notify(1002, n); } catch (SecurityException ignored) {}
        stopForeground(true);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
