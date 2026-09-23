package com.thirddigital.appupdate;

import android.app.ActivityOptions;
import android.app.PendingIntent;
import android.os.Build;

/** Sender-side send with background-start opt-in (API 34+). */
final class ApkRelaunchSender {

    private ApkRelaunchSender() {
    }

    static boolean send(PendingIntent operation) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                try {
                    ActivityOptions opts = ActivityOptions.makeBasic()
                            .setPendingIntentBackgroundActivityStartMode(
                                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                    operation.send(null, 0, null, null, null, null, opts.toBundle());
                    return true;
                } catch (PendingIntent.CanceledException e) {
                    return false;
                } catch (Throwable ignored) {
                }
            }
            operation.send();
            return true;
        } catch (PendingIntent.CanceledException e) {
            return false;
        } catch (Throwable ex) {
            return false;
        }
    }
}
