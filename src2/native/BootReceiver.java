package com.redpencil.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Brings Redpencil Phone back online after the phone restarts or the app is updated. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
            && !"android.intent.action.QUICKBOOT_POWERON".equals(a) && !"android.intent.action.LOCKED_BOOT_COMPLETED".equals(a)) return;
        if (!CallService.signedIn(context)) return;
        try { CallService.start(context, false); } catch (Exception ignored) {}
    }
}
