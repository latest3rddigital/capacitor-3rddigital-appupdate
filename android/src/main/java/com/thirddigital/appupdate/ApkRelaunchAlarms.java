package com.thirddigital.appupdate;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Alarm side of the relaunch chain (setAlarmClock -> our receiver). */
final class ApkRelaunchAlarms {

    private ApkRelaunchAlarms() {
    }

    static void schedule(Context context, Intent launch) {
        try {
            AlarmManager am = (AlarmManager)
                    context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) {
                throw new IllegalStateException("AlarmManager unavailable");
            }
            PendingIntent op = alarmIntent(context);
            long at = System.currentTimeMillis()
                    + ApkRelaunchHelper.RELAUNCH_DELAY_MS;
            try {
                am.setAlarmClock(
                        new AlarmManager.AlarmClockInfo(
                                at,
                                ApkRelaunchPendingIntents.activity(context, launch)),
                        op);
            } catch (Throwable ignored) {
                fallback(am, at, op);
            }
        } catch (Throwable ex) {
            ApkRelaunchHelper.tryDirectStart(context, launch);
        }
    }

    private static void fallback(AlarmManager am, long at, PendingIntent op) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            boolean exact = true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try {
                    exact = am.canScheduleExactAlarms();
                } catch (Throwable ignored) {
                    exact = true;
                }
            }
            if (exact) {
                try {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, op);
                    return;
                } catch (Throwable ignored) {
                }
            }
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, op);
        } else {
            //noinspection deprecation
            am.set(AlarmManager.RTC_WAKEUP, at, op);
        }
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent i = new Intent(context, ApkRelaunchAlarmReceiver.class);
        i.setAction(ApkRelaunchHelper.ACTION_RELAUNCH_ALARM);
        int f = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(
                context, ApkRelaunchHelper.ALARM_REQUEST_CODE, i, f);
    }

    static void cancel(Context context) {
        try {
            AlarmManager am = (AlarmManager)
                    context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) {
                return;
            }
            Intent i = new Intent(context, ApkRelaunchAlarmReceiver.class);
            i.setAction(ApkRelaunchHelper.ACTION_RELAUNCH_ALARM);
            int f = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent op;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                op = PendingIntent.getBroadcast(
                        context, ApkRelaunchHelper.ALARM_REQUEST_CODE, i,
                        f | PendingIntent.FLAG_NO_CREATE);
            } else {
                op = PendingIntent.getBroadcast(
                        context, ApkRelaunchHelper.ALARM_REQUEST_CODE, i, f);
            }
            if (op != null) {
                am.cancel(op);
                op.cancel();
            }
        } catch (Throwable ignored) {
        }
    }
}
