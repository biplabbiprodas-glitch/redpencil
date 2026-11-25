package com.redpencil.phone;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RPNativePlugin.class);
        super.onCreate(savedInstanceState);
        try {
            WebView wv = getBridge().getWebView();
            // Keep the app's engine running at high priority while the screen is off / app is in background.
            if (Build.VERSION.SDK_INT >= 26) wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        } catch (Exception ignored) {}
        handleCallIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleCallIntent(intent);
    }

    private void handleCallIntent(Intent i) {
        if (i == null) return;
        String a = i.getStringExtra("rp_action");
        if (a == null) return;
        i.removeExtra("rp_action");
        if (a.equals("incoming") || a.equals("answer")) {
            showOverLock(true);
            if (a.equals("answer")) NotificationManagerCompat.from(this).cancel(RPNativePlugin.NOTIF_INCOMING);
        }
        if (RPNativePlugin.instance != null) RPNativePlugin.instance.dispatchAction(a);
        else RPNativePlugin.pendingAction = a;
    }

    /** Show this screen on top of the lock screen and wake the display (only while a call is ringing/active). */
    public void showOverLock(boolean on) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(on);
            setTurnScreenOn(on);
        } else {
            int f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (on) getWindow().addFlags(f); else getWindow().clearFlags(f);
        }
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
