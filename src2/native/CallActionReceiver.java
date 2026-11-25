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
        String callId = intent.getStringExtra("callId");
        boolean appAwake = RPNativePlugin.instance != null && System.currentTimeMillis() - CallService.lastJsBeat < CallService.JS_STALE_MS;
        if (appAwake) RPNativePlugin.instance.dispatchAction("decline");
        // Tell the caller directly too, in case the app screen is asleep and never saw the call.
        if (callId != null && !callId.isEmpty()) CallService.declineCall(context, callId);
    }
}
