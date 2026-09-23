package com.thirddigital.appupdate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Fires when this package is replaced - including installs performed by the
 * system installer ({@code ACTION_VIEW} fallback) where our PackageInstaller
 * status callback never runs. Only relaunches when <i>we</i> armed an update
 * (see ApkRelaunchHelper), so unrelated updates never pop the app open.
 *
 * <p>Note: this receiver runs in the <i>newly installed</i> package, so it
 * survives the process kill that wipes out the install-status receiver path.</p>
 */
public class ApkPackageReplacedReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || context == null) {
            return;
        }
        String action = intent.getAction();
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        ApkRelaunchHelper.relaunchApp(context);
    }
}
