package com.thirddigital.appupdate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/**
 * Receives the install status broadcast from the system {@link PackageInstaller}
 * and forwards it to the {@link ApkUpdaterPlugin} so the web layer can observe
 * the install progress through the installState event.
 *
 * <p>After a successful self-update the app is relaunched via
 * {@link ApkRelaunchHelper} (direct start + alarm chain + tap-to-open
 * notification fallback - see that class for why all three are needed on
 * Android 10..16).</p>
 */
public class ApkInstallStatusReceiver extends BroadcastReceiver {

    public static final String ACTION_INSTALL_STATUS =
            "com.thirddigital.appupdate.ACTION_INSTALL_STATUS";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_INSTALL_STATUS.equals(intent.getAction())) {
            return;
        }

        int status = intent.getIntExtra(
                PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @SuppressWarnings("deprecation")
            Intent confirmIntent = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmIntent != null) {
                confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(confirmIntent);
                } catch (Exception ignored) {
                }
            }
        }

        ApkUpdaterPlugin.forwardInstallStatus(status, message);

        if (status == PackageInstaller.STATUS_SUCCESS) {
            ApkRelaunchHelper.relaunchApp(context);
        }
    }
}
