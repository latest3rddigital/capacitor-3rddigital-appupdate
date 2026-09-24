package com.thirddigital.appupdate;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Native Android plugin for the in-app APK update flow.
 *
 * <p>This is intentionally kept separate from the OTA bundle flow (Capgo) so it
 * never affects iOS or bundle updates. It can report the installed app info,
 * request the special permissions through a NATIVE dialog (host app theme +
 * logo, so it looks like a system popup in every project - see
 * {@link #requestUpdatePermissions}), download an APK from a URL (S3) with
 * progress events, install it via the system PackageInstaller (silent
 * self-update on Android 12+ when allowed) and restart the app.</p>
 */
@CapacitorPlugin(
    name = "ApkUpdater",
    permissions = {
        @Permission(
            strings = { "android.permission.POST_NOTIFICATIONS" },
            alias = "notifications"
        )
    }
)
public class ApkUpdaterPlugin extends Plugin {

    private static final String UPDATE_DIR = "apk_updates";
    private static final String EVENT_DOWNLOAD_PROGRESS = "downloadProgress";
    private static final String EVENT_INSTALL_STATE = "installState";
    private static final String TAG = "ApkUpdater";
    private static final String APK_MIME_TYPE = "application/vnd.android.package-archive";
    /** Suffix of the FileProvider authority declared in this plugin's manifest. */
    private static final String FILE_PROVIDER_SUFFIX = ".appupdate.fileprovider";

    /**
     * Privileged permission that allows an update without user action on
     * Android 12+. Regular apps do not hold it, so the plugin only attempts a
     * silent install when it is actually granted and always falls back to the
     * system installer dialog.
     */
    private static final String PERMISSION_UPDATE_WITHOUT_USER_ACTION =
            "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION";

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;

    /** Reference to the live plugin instance, used by the status broadcast receiver. */
    private static WeakReference<ApkUpdaterPlugin> instanceRef = new WeakReference<>(null);

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile File lastDownloadedFile;

    /**
     * Set while a silent (no user action) install session is in flight so that
     * an asynchronous rejection from the system can be retried once with the
     * user-confirmed session (and, as a last resort, the installer intent).
     */
    private volatile File pendingSilentInstallFile;
    private volatile boolean silentFallbackUsed;

    @Override
    public void load() {
        instanceRef = new WeakReference<>(this);
        // The app is actually running again: consume the pending relaunch
        // (cancels the alarm, dismisses the tap-to-open notification).
        ApkRelaunchHelper.onAppLaunched(getContext());
    }

    /**
     * Continues the native permission dialog flow after the user comes back
     * from the App info page.
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!awaitingPermissionSettings) return;
        awaitingPermissionSettings = false;
        // Give the Settings toggles a beat to commit, then re-check BOTH
        // permissions and resolve the flow.
        mainHandler.postDelayed(() -> continuePermissionFlow(true), 250);
    }

    /** Called by {@link ApkInstallStatusReceiver} when the system reports an install status. */
    static void forwardInstallStatus(final int status, final String message) {
        final ApkUpdaterPlugin plugin = instanceRef.get();
        if (plugin == null) {
            return;
        }
        plugin.mainHandler.post(() -> plugin.handleInstallStatus(status, message));
    }

    private void handleInstallStatus(int status, String message) {
        // A silent session can fail asynchronously (the system rejects
        // USER_ACTION_NOT_REQUIRED on devices without the privileged
        // permission). Retry once with the user-confirmed session instead of
        // reporting a failure the user could not do anything about.
        boolean silentAttemptFailed =
                pendingSilentInstallFile != null
                        && !silentFallbackUsed
                        && status != PackageInstaller.STATUS_SUCCESS
                        && status != PackageInstaller.STATUS_PENDING_USER_ACTION;

        if (silentAttemptFailed) {
            final File apkFile = pendingSilentInstallFile;
            pendingSilentInstallFile = null;
            silentFallbackUsed = true;
            Log.w(TAG, "Silent install was rejected, retrying with the system installer");
            emitInstallState(
                    "pending_user_action",
                    "Silent install not allowed - using the system installer");
            executor.execute(() -> retryInstallWithoutSilent(apkFile));
            return;
        }

        String state;
        if (status == PackageInstaller.STATUS_SUCCESS) {
            state = "success";
        } else if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            state = "pending_user_action";
        } else {
            state = "failure";
        }
        emitInstallState(state, message);
    }

    /** Second chance: user-confirmed session, then the installer intent. */
    private void retryInstallWithoutSilent(File apkFile) {
        if (apkFile == null || !apkFile.exists()) {
            try {
                ApkRelaunchHelper.setExpectRelaunch(getContext(), false);
            } catch (Throwable ignored) {
            }
            emitInstallState("failure", "The downloaded APK is no longer available");
            return;
        }
        try {
            commitSession(apkFile, false);
            return;
        } catch (Exception sessionError) {
            Log.w(TAG, "User-confirmed install session failed, using the installer intent", sessionError);
            try {
                installViaIntent(apkFile);
            } catch (Exception intentError) {
                intentError.addSuppressed(sessionError);
                try {
                    ApkRelaunchHelper.setExpectRelaunch(getContext(), false);
                } catch (Throwable ignored) {
                }
                emitInstallState(
                        "failure",
                        "APK install failed: " + intentError.getMessage());
            }
        }
    }

    /** Emits the "installState" event (always from the main thread). */
    private void emitInstallState(final String state, final String message) {
        emitInstallState(state, message, null);
    }

    /**
     * Emits the "installState" event (always from the main thread).
     *
     * @param percent optional 0-100 progress, used by the "staging" state
     *                while the APK is copied into the install session
     */
    private void emitInstallState(final String state, final String message, final Integer percent) {
        mainHandler.post(() -> {
            JSObject data = new JSObject();
            data.put("state", state);
            if (message != null && !message.isEmpty()) {
                data.put("message", message);
            }
            if (percent != null) {
                data.put("percent", percent);
            }
            notifyListeners(EVENT_INSTALL_STATE, data);
        });
    }

    // ---------------------------------------------------------------------
    // App info
    // ---------------------------------------------------------------------

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        try {
            Context context = getContext();
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            // Lets the JS layer refuse a debug-APK update on a release install.
            boolean debuggable =
                    (context.getApplicationInfo().flags
                                    & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)
                            != 0;
            JSObject result = new JSObject();
            result.put("packageName", context.getPackageName());
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", PackageInfoCompat.getLongVersionCode(info));
            result.put("debuggable", debuggable);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("Failed to read app info", ex);
        }
    }

    // ---------------------------------------------------------------------
    // Install permission ("install unknown apps")
    // ---------------------------------------------------------------------

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("canInstall", canRequestInstalls());
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        Context context = getContext();
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.getPackageName()));
            } else {
                intent = new Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + context.getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivitySafely(intent);
            call.resolve();
        } catch (Exception ex) {
            call.reject("Unable to open install permission settings", ex);
        }
    }

    // -------------------------------------------------------------------------
    // Permission prompt - ONE native dialog (host app theme + logo) covering
    // BOTH special permissions, so consuming projects never need custom UI.
    // -------------------------------------------------------------------------

    /** Pending JS call while the native permission flow is running (main thread). */
    private PluginCall permissionCall;
    /** True while the flow waits for the user to come back from App info. */
    private volatile boolean awaitingPermissionSettings;

    /**
     * ONE native dialog for BOTH special permissions ("Install unknown apps"
     * - required for the update itself - and "Display over other apps" - the
     * auto-reopen helper). The dialog is a plain Android AlertDialog (app
     * logo + host app theme, so it looks like a system permission popup in
     * every project) that lists BOTH messages together; Continue opens the
     * app's <b>App info page</b> where BOTH toggles live (Android 8+ lists
     * "Install unknown apps", Android 6+ lists "Display over other apps"), so
     * the user allows everything in one place and comes back once -
     * {@link #handleOnResume()} re-checks both toggles and resolves.
     *
     * <p>Resolves with the final {@code { canInstall, canDrawOverlays, ready }}
     * status. Declining ("Not now", or coming back from App info without
     * granting) resolves with {@code ready: false} - it never rejects, and the
     * prompt is simply shown again on the next launch while not ready.</p>
     *
     * <p>Optional copy overrides: {@code title}, {@code message},
     * {@code confirmText}, {@code cancelText}.</p>
     */
    @PluginMethod
    public void requestUpdatePermissions(PluginCall call) {
        if (permissionCall != null) {
            call.reject("A permission request is already in progress");
            return;
        }
        permissionCall = call;
        mainHandler.post(() -> continuePermissionFlow(false));
    }

    /**
     * Resolves when both toggles are granted; otherwise shows the single
     * combined dialog. After the App info trip the flow always finishes:
     * ONE trip is supposed to cover both toggles, re-showing immediately
     * would nag - the prompt simply runs again on the next launch if still
     * not ready.
     *
     * @param returnedFromSettings true when resuming after the App info trip
     */
    private void continuePermissionFlow(boolean returnedFromSettings) {
        if (permissionCall == null) return;
        boolean canInstall = canRequestInstalls();
        boolean canOverlay = canDrawOverlaysNow();
        if (canInstall && canOverlay) {
            finishPermissionFlow();
            return;
        }
        if (returnedFromSettings) {
            finishPermissionFlow();
            return;
        }
        showPermissionDialog(canInstall, canOverlay);
    }

    /**
     * The ONE native dialog that describes BOTH permissions together:
     * host-app theme, the app's own logo and optional copy overrides from
     * the JS call. There is no per-project UI here - it renders like a
     * native permission popup in every consuming app. Continue opens the
     * App info page so the user enables both toggles in one place.
     *
     * @param installGranted current state of "Install unknown apps"
     * @param overlayGranted current state of "Display over other apps"
     */
    private void showPermissionDialog(
            final boolean installGranted,
            final boolean overlayGranted) {
        final PluginCall call = permissionCall;
        if (call == null) return;
        final Activity activity = getActivity();
        if (activity == null) {
            // No UI to prompt with - report the current state instead of hanging.
            finishPermissionFlow();
            return;
        }

        final Context context = getContext();
        final String appName = context
                .getApplicationInfo()
                .loadLabel(context.getPackageManager())
                .toString();
        final String title = firstNonEmpty(call.getString("title"), "Allow app updates");
        final String message = firstNonEmpty(
                call.getString("message"),
                "To keep \"" + appName + "\" up to date, allow both permissions on the "
                        + "next screen:\n\n"
                        + "1. Install unknown apps - required to install app updates"
                        + (installGranted ? " (already allowed)." : ".") + "\n"
                        + "2. Display over other apps - lets the app reopen itself "
                        + "automatically after an update"
                        + (overlayGranted ? " (already allowed)." : ".") + "\n\n"
                        + "Tap Continue, then enable both on this app's App info page.");
        final String confirmText = firstNonEmpty(call.getString("confirmText"), "Continue");
        final String cancelText = firstNonEmpty(call.getString("cancelText"), "Not now");

        activity.runOnUiThread(() -> {
            if (permissionCall == null || getActivity() == null) return;
            try {
                new AlertDialog.Builder(getActivity())
                        .setIcon(loadAppLogo())
                        .setTitle(title)
                        .setMessage(message)
                        .setCancelable(false)
                        .setPositiveButton(
                                confirmText,
                                (dialog, which) -> openAppInfoForPermissions())
                        .setNegativeButton(
                                cancelText,
                                (dialog, which) -> finishPermissionFlow())
                        .show();
            } catch (Exception ex) {
                Log.w(TAG, "Unable to show the permission dialog", ex);
                finishPermissionFlow();
            }
        });
    }

    /**
     * The single redirect: this app's App info page. It is ONE stable intent
     * ({@link Settings#ACTION_APPLICATION_DETAILS_SETTINGS} + package uri)
     * that works on every Android version - Android 6+ lists "Display over
     * other apps" and Android 8+ also lists "Install unknown apps", so the
     * user enables BOTH toggles in one place and returns once. (Below
     * Android 8 the install permission needs no entry here at all - the
     * system installer shows its own "Unknown sources" dialog at install
     * time, see {@link #canRequestInstalls()}.)
     */
    private void openAppInfoForPermissions() {
        try {
            Intent intent = new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            awaitingPermissionSettings = true;
            startActivitySafely(intent);
        } catch (Exception ex) {
            Log.w(TAG, "Unable to open the App info page", ex);
            awaitingPermissionSettings = false;
            finishPermissionFlow();
        }
    }

    /** Resolves the pending JS call with the final permission status. */
    private void finishPermissionFlow() {
        awaitingPermissionSettings = false;
        PluginCall call = permissionCall;
        permissionCall = null;
        if (call == null) return;
        boolean canInstall = canRequestInstalls();
        boolean canOverlay = canDrawOverlaysNow();
        JSObject result = new JSObject();
        result.put("canInstall", canInstall);
        result.put("canDrawOverlays", canOverlay);
        result.put("ready", canInstall && canOverlay);
        call.resolve(result);
    }

    /** The host app's own logo - what makes the dialog look native everywhere. */
    private Drawable loadAppLogo() {
        try {
            Context context = getContext();
            Drawable logo = context.getApplicationInfo().loadLogo(context.getPackageManager());
            if (logo != null) return logo;
            return context.getApplicationInfo().loadIcon(context.getPackageManager());
        } catch (Exception ex) {
            return getContext().getPackageManager().getDefaultActivityIcon();
        }
    }

    private static String firstNonEmpty(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    /**
     * One-shot readiness check for the pre-update gate:
     * {@code { canInstall, canDrawOverlays, ready }} - see
     * {@link #requestUpdatePermissions} for the prompting flow.
     */
    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        JSObject result = new JSObject();
        boolean canInstall = canRequestInstalls();
        boolean canOverlay = canDrawOverlaysNow();
        result.put("canInstall", canInstall);
        result.put("canDrawOverlays", canOverlay);
        result.put("ready", canInstall && canOverlay);
        call.resolve(result);
    }

    private boolean canDrawOverlaysNow() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                return Settings.canDrawOverlays(getContext());
            }
            return true;
        } catch (Exception ex) {
            return true;
        }
    }

    private boolean canRequestInstalls() {
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return context.getPackageManager().canRequestPackageInstalls();
        }
        // Below Android 8 there is NO per-app "Install unknown apps" entry on
        // the App info page (Android 8+ adds it), so a strict check could
        // never be satisfied from the single redirect we show and the update
        // gate would block forever. The global "Unknown sources" toggle lives
        // in Settings > Security there, and the system installer shows its
        // own dialog for it at install time anyway - so from the app's
        // perspective the permission needs no Settings trip below Android 8.
        return true;
    }

    // ---------------------------------------------------------------------
    // Notifications ("Update installed - tap to open" fallback)
    // ---------------------------------------------------------------------

    /**
     * Whether the fallback notification can be shown right now. Always true
     * on Android 12 and below (permission is auto-granted); on Android 13+
     * reflects the POST_NOTIFICATIONS runtime grant.
     */
    @PluginMethod
    public void canNotify(PluginCall call) {
        JSObject result = new JSObject();
        result.put("canNotify", notificationsEnabled());
        call.resolve(result);
    }

    /**
     * Asks for POST_NOTIFICATIONS with the standard in-app system dialog on
     * Android 13+ (no Settings trip). Resolves {@code { granted: true/false }}.
     * On Android 12 and below - or when the permission is already granted -
     * resolves {@code { granted: true }} immediately without any dialog.
     */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || notificationsEnabled()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        boolean granted =
                getPermissionState("notifications") == PermissionState.GRANTED;
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private boolean notificationsEnabled() {
        try {
            Context context = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && context.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                            != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            return androidx.core.app.NotificationManagerCompat.from(context)
                    .areNotificationsEnabled();
        } catch (Throwable ignored) {
            return true;
        }
    }

    private void startActivitySafely(Intent intent) {
        if (getActivity() != null) {
            getActivity().startActivity(intent);
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
    }

    // ---------------------------------------------------------------------
    // Download
    // ---------------------------------------------------------------------

    /**
     * Downloads the APK from the given URL (S3) into the app's internal
     * "apk_updates" directory and reports progress through the
     * {@code downloadProgress} event. Resolves with the local file path and
     * the size in bytes.
     */
    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        if (!downloading.compareAndSet(false, true)) {
            call.reject("A download is already in progress");
            return;
        }
        final String versionName = call.getString("versionName", "");
        executor.execute(() -> {
            File target = null;
            try {
                File dir = getUpdateDir();
                clearUpdateDir(dir);
                String safeVersion = versionName.replaceAll("[^A-Za-z0-9._-]", "_");
                String fileName = "update_" + (safeVersion.isEmpty() ? "latest" : safeVersion) + ".apk";
                target = new File(dir, fileName);
                long size = downloadApk(url, target, versionName);
                lastDownloadedFile = target;
                JSObject result = new JSObject();
                result.put("path", target.getAbsolutePath());
                result.put("size", size);
                call.resolve(result);
            } catch (Exception ex) {
                if (target != null && target.exists()) {
                    // Do not leave partial files behind.
                    target.delete();
                }
                lastDownloadedFile = null;
                call.reject("APK download failed", ex);
            } finally {
                downloading.set(false);
            }
        });
    }

    private long downloadApk(String url, File target, String versionName) throws IOException {
        HttpURLConnection connection = null;
        InputStream input = null;
        OutputStream output = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);

            int responseCode = connection.getResponseCode();
            if (responseCode < HttpURLConnection.HTTP_OK || responseCode >= HttpURLConnection.HTTP_MULT_CHOICE) {
                throw new IOException("Unexpected HTTP response code: " + responseCode);
            }

            long totalBytes = connection.getContentLength();
            if (totalBytes < 0) {
                totalBytes = 0;
            }

            input = new BufferedInputStream(connection.getInputStream());
            output = new FileOutputStream(target);

            byte[] buffer = new byte[8192];
            long bytesWritten = 0;
            int lastPercent = -1;
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                bytesWritten += read;
                if (totalBytes > 0) {
                    int percent = (int) Math.min(100, (bytesWritten * 100) / totalBytes);
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        notifyDownloadProgress(percent, bytesWritten, totalBytes, versionName);
                    }
                }
            }
            output.flush();
            // Always emit the final event so the web layer can await completion.
            notifyDownloadProgress(100, bytesWritten, totalBytes, versionName);
            return bytesWritten;
        } finally {
            if (output != null) {
                try { output.close(); } catch (IOException ignored) { }
            }
            if (input != null) {
                try { input.close(); } catch (IOException ignored) { }
            }
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void notifyDownloadProgress(
            final int percent,
            final long bytesWritten,
            final long totalBytes,
            final String versionName) {
        // Capacitor events must be dispatched from the main thread.
        mainHandler.post(() -> {
            JSObject data = new JSObject();
            data.put("percent", percent);
            data.put("bytesWritten", bytesWritten);
            data.put("totalBytes", totalBytes);
            data.put("versionName", versionName == null ? "" : versionName);
            notifyListeners(EVENT_DOWNLOAD_PROGRESS, data);
        });
    }

    private File getUpdateDir() {
        File dir = new File(getContext().getFilesDir(), UPDATE_DIR);
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    private void clearUpdateDir(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            file.delete();
        }
    }

    // ---------------------------------------------------------------------
    // Install
    // ---------------------------------------------------------------------

    /**
     * Installs the downloaded APK (self-update).
     *
     * <p>Strategy:</p>
     * <ol>
     *   <li>If - and only if - the device allows a silent self-update
     *       (Android 12+ with the privileged UPDATE_PACKAGES_WITHOUT_USER_ACTION
     *       permission), a PackageInstaller session with
     *       USER_ACTION_NOT_REQUIRED is committed. An asynchronous rejection is
     *       detected by {@link #handleInstallStatus} and retried below,</li>
     *   <li>PackageInstaller session with the standard confirmation dialog
     *       (the ApkInstallStatusReceiver opens it),</li>
     *   <li>fallback: open the system installer via a FileProvider intent.</li>
     * </ol>
     */
    @PluginMethod
    public void install(final PluginCall call) {
        if (downloading.get()) {
            call.reject("A download is still in progress");
            return;
        }
        final String filePath = call.getString("filePath");
        final File apkFile = (filePath != null && !filePath.isEmpty())
                ? new File(filePath)
                : lastDownloadedFile;
        if (apkFile == null || !apkFile.exists()) {
            call.reject("APK file not found. Download the APK first.");
            return;
        }
        if (apkFile.length() <= 0) {
            call.reject("The downloaded APK is empty. Please try the update again.");
            return;
        }

        // Safety: this flow is a self-update only. Never hand a different app
        // (wrong flavor / wrong download) to the installer.

        // Arm the auto-relaunch BEFORE committing the session: from here on
        // the process can be killed at any moment by the install.
        ApkRelaunchHelper.setExpectRelaunch(getContext(), true);

        final boolean canInstallSilently = canInstallWithoutUserAction();
        silentFallbackUsed = false;
        pendingSilentInstallFile = canInstallSilently ? apkFile : null;

        executor.execute(() -> {
            // Safety: this flow is a self-update only. Never hand a different app
            // (wrong flavor / wrong download) to the installer. Done off the
            // bridge thread because it reads + parses the APK.
            final String validationError = validateApkForSelfUpdate(apkFile);
            if (validationError != null) {
                pendingSilentInstallFile = null;
                // Not a real install - disarm the relaunch we armed above.
                try {
                    ApkRelaunchHelper.setExpectRelaunch(getContext(), false);
                } catch (Throwable ignored) {
                }
                call.reject(validationError);
                return;
            }
            if (canInstallSilently) {
                try {
                    commitSession(apkFile, true);
                    resolveInstallStarted(call, "silent_self_update");
                    return;
                } catch (Throwable silentError) {
                    // The device does not actually allow it - use the
                    // user-confirmed flow instead.
                    pendingSilentInstallFile = null;
                    silentFallbackUsed = true;
                    Log.w(TAG, "Silent install session not available", silentError);
                }
            }
            try {
                commitSession(apkFile, false);
                resolveInstallStarted(call, "pending_user_action");
                return;
            } catch (Exception sessionError) {
                try {
                    installViaIntent(apkFile);
                    resolveInstallStarted(call, "install_intent_started");
                } catch (Exception intentError) {
                    intentError.addSuppressed(sessionError);
                    // Neither path started an install - disarm the relaunch.
                    try {
                        ApkRelaunchHelper.setExpectRelaunch(getContext(), false);
                    } catch (Throwable ignored) {
                    }
                    call.reject(
                            "APK install failed: " + intentError.getMessage(),
                            intentError);
                }
            }
        });
    }

    /**
     * The APK we install must belong to the running app and must not be a
     * downgrade - otherwise the system would reject it with a confusing
     * INSTALL_FAILED_UPDATE_INCOMPATIBLE / VERSION_DOWNGRADE error.
     *
     * @return an error message when the APK must not be installed, else null.
     */
    private String validateApkForSelfUpdate(File apkFile) {
        try {
            Context context = getContext();
            PackageManager packageManager = context.getPackageManager();
            PackageInfo archive = packageManager.getPackageArchiveInfo(
                    apkFile.getAbsolutePath(), 0);
            if (archive == null) {
                return "The downloaded APK could not be read (corrupted download?).";
            }
            if (!context.getPackageName().equals(archive.packageName)) {
                return "The downloaded APK belongs to a different app ("
                        + archive.packageName + "), not to " + context.getPackageName() + ".";
            }
            long archiveVersionCode = PackageInfoCompat.getLongVersionCode(archive);
            PackageInfo installed = packageManager.getPackageInfo(context.getPackageName(), 0);
            if (archiveVersionCode < PackageInfoCompat.getLongVersionCode(installed)) {
                return "The downloaded APK (versionCode " + archiveVersionCode
                        + ") is older than the installed version.";
            }
            return null;
        } catch (Exception ex) {
            return "Failed to validate the downloaded APK: " + ex.getMessage();
        }
    }

    /**
     * True only when the OS would allow installing the update without any user
     * action. Requires Android 12+ and the privileged
     * UPDATE_PACKAGES_WITHOUT_USER_ACTION permission, which normal apps never
     * hold - so the common path is the user-confirmed system installer dialog.
     */
    private boolean canInstallWithoutUserAction() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return false;
        }
        try {
            return getContext().checkSelfPermission(PERMISSION_UPDATE_WITHOUT_USER_ACTION)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable ex) {
            return false;
        }
    }

    private void resolveInstallStarted(PluginCall call, String status) {
        JSObject result = new JSObject();
        result.put("status", status);
        result.put("message", "Install session committed");
        call.resolve(result);
    }

    private void commitSession(File apkFile, boolean silent) throws IOException {
        Context context = getContext();
        PackageManager packageManager = context.getPackageManager();

        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        // USER_ACTION_NOT_REQUIRED / setRequireUserAction only exist on Android
        // 12+ (API 31). Calling them on API 30 would throw NoSuchMethodError
        // (an Error, not an Exception), which would kill the app process.
        if (silent && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            } catch (Throwable ignored) {
                // Not allowed on this device/OS; the commit below will fall back.
            }
        }
        // Show the app label in the system installer dialog (setAppLabel is the
        // real API - SessionParams has no setTitle).
        try {
            params.setAppLabel(context.getApplicationInfo().loadLabel(packageManager));
        } catch (Exception ignored) {
            // Cosmetic only.
        }

        PackageInstaller installer = packageManager.getPackageInstaller();
        int sessionId = installer.createSession(params);
        PackageInstaller.Session session = null;
        try {
            session = installer.openSession(sessionId);
            OutputStream out = session.openWrite(apkFile.getName(), 0, apkFile.length());
            InputStream in = new FileInputStream(apkFile);
            try {
                byte[] buffer = new byte[65536];
                long total = apkFile.length();
                long copied = 0;
                int lastPercent = -1;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    copied += read;
                    // Real staging progress so the web layer can keep the bar
                    // moving while the APK is written into the session.
                    if (total > 0) {
                        int percent = (int) Math.min(100, (copied * 100) / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            emitInstallState("staging", null, percent);
                        }
                    }
                }
                session.fsync(out);
            } finally {
                try { in.close(); } catch (IOException ignored) { }
                try { out.close(); } catch (IOException ignored) { }
            }

            Intent statusIntent = new Intent(context, ApkInstallStatusReceiver.class);
            statusIntent.setAction(ApkInstallStatusReceiver.ACTION_INSTALL_STATUS);
            PendingIntent statusPendingIntent = PendingIntent.getBroadcast(
                    context, sessionId, statusIntent, getPendingIntentFlags());
            session.commit(statusPendingIntent.getIntentSender());
        } finally {
            if (session != null) {
                session.close();
            }
        }
    }

    private int getPendingIntentFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
        }
        return PendingIntent.FLAG_UPDATE_CURRENT;
    }

    /**
     * Fallback: hand the APK to the system installer through a FileProvider
     * intent. ACTION_VIEW + a content:// URI with a read grant is the most
     * widely compatible way to trigger the installer (ACTION_INSTALL_PACKAGE is
     * deprecated and ignores the URI on newer Android versions).
     *
     * <p>The authority must match the FileProvider declared in the plugin's
     * AndroidManifest ({@code ${applicationId}.appupdate.fileprovider}).</p>
     */
    private void installViaIntent(File apkFile) throws IOException {
        Context context = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            Uri apkUri = FileProvider.getUriForFile(
                    context,
                    context.getPackageName() + FILE_PROVIDER_SUFFIX,
                    apkFile);
            intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, APK_MIME_TYPE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // Historic helper flags for unknown-source installs (harmless if ignored).
            intent.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
            intent.putExtra(Intent.EXTRA_RETURN_RESULT, false);
        } else {
            intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.fromFile(apkFile), APK_MIME_TYPE);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivitySafely(intent);
    }

    // ---------------------------------------------------------------------
    // Restart
    // ---------------------------------------------------------------------

    /** Relaunches the app (main launcher task) and kills the current process. */
    @PluginMethod
    public void restartApp(final PluginCall call) {
        try {
            Context context = getContext();
            Intent launch = context.getPackageManager()
                    .getLaunchIntentForPackage(context.getPackageName());
            if (launch == null) {
                call.reject("Unable to resolve the app launch intent");
                return;
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            startActivitySafely(launch);
            // Give the bridge a moment to deliver the resolve, then kill the process.
            mainHandler.postDelayed(() -> Runtime.getRuntime().exit(0), 250);
            call.resolve();
        } catch (Exception ex) {
            call.reject("Failed to restart the app", ex);
        }
    }
}
