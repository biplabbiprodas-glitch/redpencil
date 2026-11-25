package com.redpencil.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

/** Handles the "Decline" button on the incoming-call notification without opening the app. */
public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        NotificationManagerCompat.from(context).cancel(RPNativePlugin.NOTIF_INCOMING);
        if (RPNativePlugin.instance != null) RPNativePlugin.instance.dispatchAction("decline");
        else RPNativePlugin.pendingAction = "decline";
    }
}
