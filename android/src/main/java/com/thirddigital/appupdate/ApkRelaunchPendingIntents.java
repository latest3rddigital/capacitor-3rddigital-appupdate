package com.thirddigital.appupdate;

import android.app.ActivityOptions;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Builds the launcher activity PendingIntent with creator BAL opt-in. */
final class ApkRelaunchPendingIntents {

    private ApkRelaunchPendingIntents() {
    }

    static PendingIntent activity(Context context, Intent launch) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                ActivityOptions opts = ActivityOptions.makeBasic()
                        .setPendingIntentCreatorBackgroundActivityStartMode(
                                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                return PendingIntent.getActivity(
                        context, ApkRelaunchHelper.RELAUNCH_REQUEST_CODE,
                        launch, flags, opts.toBundle());
            } catch (Throwable ignored) {
            }
        }
        return PendingIntent.getActivity(
                context, ApkRelaunchHelper.RELAUNCH_REQUEST_CODE, launch, flags);
    }
}
