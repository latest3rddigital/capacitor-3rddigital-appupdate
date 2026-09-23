package com.thirddigital.appupdate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Fired by AlarmManager after a successful self-update. We are the
 * <i>sender</i> of the activity PendingIntent here, so we apply the
 * sender-side background-start opt-in (API 34+) that the AlarmManager
 * service itself never sets - combined with the creator opt-in on the
 * PendingIntent this is the best available shot at a fully automatic
 * reopen on Android 14/15/16.
 */
public class ApkRelaunchAlarmReceiver extends BroadcastReceiver {

    private static final String TAG = "ApkUpdater";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null
                || !ApkRelaunchHelper.ACTION_RELAUNCH_ALARM.equals(intent.getAction())) {
            return;
        }
        if (!ApkRelaunchHelper.shouldRelaunch(context)) {
            return;
        }
        Intent launch = ApkRelaunchHelper.resolveLaunchIntent(context);
        if (launch == null) {
            Log.e(TAG, "Unable to resolve the app launch intent for the relaunch");
            ApkRelaunchNotifications.showTapToOpen(context, null);
            return;
        }
        boolean sent = ApkRelaunchSender.send(
                ApkRelaunchPendingIntents.activity(context, launch));
        if (!sent) {
            Log.w(TAG, "Alarm relaunch send failed, trying direct start");
            ApkRelaunchHelper.tryDirectStart(context, launch);
        }
    }
}
