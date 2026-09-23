package com.thirddigital.appupdate;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Shared relaunch logic for the APK self-update flow.
 *
 * <p>After a self-update the OS kills the old process and the app must come
 * back by itself. A plain startActivity() from the background is blocked
 * silently on Android 10+, and a bare AlarmManager activity PendingIntent is
 * dropped on Android 14/15/16 unless both the creator and the sender opt in
 * to background starts. So no single trick works everywhere - this helper
 * layers every documented mechanism:</p>
 *
 * <ol>
 *   <li>Direct start - instant below Android 10 and whenever we still hold a
 *       BAL privilege window (fresh broadcast delivery / recent foreground).
 *   <li>Alarm chain: setAlarmClock() fires an explicit broadcast to
 *       ApkRelaunchAlarmReceiver, which then sends the activity PendingIntent
 *       itself with the sender-side background-start opt-in (API 34+) that
 *       the alarm service never sets for us.
 *   <li>High-priority tap-to-open notification (plain content intent, no
 *       overlay / full-screen intent needed). A user tap always grants a
 *       background start, so the app can always be reopened with one tap. Also covers installs done by the
 *       system installer (ACTION_VIEW fallback) where our PackageInstaller
 *       status callback never fires.
 * </ol>
 *
 * <p>The relaunch is armed only when we started an update, so an unrelated
 * update (Play/adb) never pops the app open.</p>
 */
public final class ApkRelaunchHelper {

    private static final String TAG = "ApkUpdater";

    private static final String PREFS = "ApkUpdaterPrefs";
    private static final String KEY_EXPECT_RELAUNCH = "expect_relaunch_after_update";

    static final String ACTION_RELAUNCH_ALARM =
            "com.thirddigital.appupdate.ACTION_RELAUNCH_ALARM";

    static final int RELAUNCH_REQUEST_CODE = 48291;
    static final int ALARM_REQUEST_CODE = 48292;
    static final int NOTIFICATION_ID = 48293;
    static final String NOTIFICATION_CHANNEL_ID = "apk_update_relaunch";
    static final long RELAUNCH_DELAY_MS = 1_200;

    private ApkRelaunchHelper() {
    }

    static void setExpectRelaunch(Context context, boolean expect) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            prefs.edit().putBoolean(KEY_EXPECT_RELAUNCH, expect).apply();
        } catch (Throwable ignored) {
        }
    }

    static boolean shouldRelaunch(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return prefs.getBoolean(KEY_EXPECT_RELAUNCH, false);
        } catch (Throwable ignored) {
            return false;
        }
    }

    static void onAppLaunched(Context context) {
        setExpectRelaunch(context, false);
        ApkRelaunchAlarms.cancel(context);
        ApkRelaunchNotifications.dismiss(context);
    }

    static void relaunchApp(Context context) {
        if (context == null) {
            return;
        }
        if (!shouldRelaunch(context)) {
            Log.i(TAG, "Skipping relaunch: no update in progress");
            return;
        }
        Intent launch = resolveLaunchIntent(context);
        if (launch == null) {
            Log.e(TAG, "Unable to resolve the app launch intent for the relaunch");
            ApkRelaunchNotifications.showTapToOpen(context, null);
            return;
        }
        if (tryDirectStart(context, launch)) {
            return;
        }
        ApkRelaunchAlarms.schedule(context, launch);
        ApkRelaunchNotifications.showTapToOpen(context, launch);
    }

    static Intent resolveLaunchIntent(Context context) {
        try {
            Intent launch = context.getPackageManager()
                    .getLaunchIntentForPackage(context.getPackageName());
            if (launch == null) {
                return null;
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            return launch;
        } catch (Throwable ex) {
            Log.w(TAG, "Unable to resolve launch intent", ex);
            return null;
        }
    }

    static boolean tryDirectStart(Context context, Intent launch) {
        try {
            context.startActivity(launch);
            Log.i(TAG, "Relaunch started directly");
            return true;
        } catch (Throwable ex) {
            Log.i(TAG, "Direct relaunch blocked, trying scheduled relaunch");
            return false;
        }
    }
}
