package com.thirddigital.appupdate;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Tap-to-open notification fallback (always works with one tap). */
final class ApkRelaunchNotifications {

    private static final String TAG = "ApkUpdater";

    private ApkRelaunchNotifications() {
    }

    static void showTapToOpen(Context context, Intent launch) {
        try {
            if (launch == null) {
                launch = ApkRelaunchHelper.resolveLaunchIntent(context);
            }
            if (launch == null || context == null) {
                return;
            }
            ensureChannel(context);
            PendingIntent content =
                    ApkRelaunchPendingIntents.activity(context, launch);
            String title = "Update installed";
            try {
                CharSequence label = context.getApplicationInfo()
                        .loadLabel(context.getPackageManager());
                if (label != null && label.length() > 0) {
                    title = label + " updated";
                }
            } catch (Throwable ignored) {
            }
            NotificationCompat.Builder b =
                    new NotificationCompat.Builder(
                            context, ApkRelaunchHelper.NOTIFICATION_CHANNEL_ID)
                            .setSmallIcon(android.R.drawable.stat_sys_download_done)
                            .setContentTitle(title)
                            .setContentText("Tap to open the updated app")
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_MAX)
                            .setCategory(NotificationCompat.CATEGORY_STATUS)
                            .setContentIntent(content);
            // NOTE: no full-screen intent here on purpose - on API 34+ that
            // would require the USE_FULL_SCREEN_INTENT permission (a Settings
            // toggle), while a plain tap-to-open notification needs none.
            Notification n = b.build();
            n.flags |= Notification.FLAG_AUTO_CANCEL;
            NotificationManagerCompat.from(context)
                    .notify(ApkRelaunchHelper.NOTIFICATION_ID, n);
            Log.i(TAG, "Posted tap-to-open notification");
        } catch (SecurityException ex) {
            Log.w(TAG, "Cannot post notification (permission revoked?)", ex);
        } catch (Throwable ex) {
            Log.w(TAG, "Cannot post notification", ex);
        }
    }

    static void dismiss(Context context) {
        try {
            NotificationManagerCompat.from(context)
                    .cancel(ApkRelaunchHelper.NOTIFICATION_ID);
        } catch (Throwable ignored) {
        }
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            NotificationManager m = (NotificationManager)
                    context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (m == null) {
                return;
            }
            if (m.getNotificationChannel(
                    ApkRelaunchHelper.NOTIFICATION_CHANNEL_ID) != null) {
                return;
            }
            NotificationChannel c = new NotificationChannel(
                    ApkRelaunchHelper.NOTIFICATION_CHANNEL_ID,
                    "App updates",
                    NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Notifies you when an update is installed");
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            m.createNotificationChannel(c);
        } catch (Throwable ignored) {
        }
    }
}
