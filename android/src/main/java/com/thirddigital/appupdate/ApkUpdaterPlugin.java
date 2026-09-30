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
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import org.json.JSONArray;

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
     * Continues the native permission flow after the user comes back from the
     * permission's Settings page (one trip per missing permission).
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!awaitingPermissionSettings) return;
        awaitingPermissionSettings = false;
        // Give the Settings toggle a beat to commit, then re-check that
        // permission and continue with the next missing one (if any).
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
        openSinglePermissionSettings(call, PERMISSION_KIND_INSTALL);
    }

    /**
     * Opens the "Display over other apps" Settings page of this app
     * ({@code ACTION_MANAGE_OVERLAY_PERMISSION} + package, Android 6+) - the
     * JS-side counterpart of the native overlay popup, for projects that render
     * their own permission UI.
     */
    @PluginMethod
    public void openOverlayPermissionSettings(PluginCall call) {
        openSinglePermissionSettings(call, PERMISSION_KIND_OVERLAY);
    }

    /**
     * Opens a permission's Settings page directly (no dialog). Used by the
     * JS-side custom-UI flow; the generic App info page is only the fallback.
     */
    private void openSinglePermissionSettings(PluginCall call, String kind) {
        if (openPermissionSettingsPage(kind) || openAppInfoSettings()) {
            call.resolve();
            return;
        }
        call.reject("Unable to open the " + kind + " permission settings");
    }

    // -------------------------------------------------------------------------
    // Permissions
    //
    // Two special-access permissions gate the APK update:
    //   1. "Install unknown apps"    (REQUEST_INSTALL_PACKAGES) - REQUIRED
    //   2. "Display over other apps" (SYSTEM_ALERT_WINDOW)      - best effort
    //
    // Neither can be granted programmatically, so the plugin ships its own
    // NATIVE popup PER permission (host app theme + app logo = it looks like a
    // system permission popup in every project, no per-project UI needed).
    // Continue opens the EXACT Settings page of that permission
    // (ACTION_MANAGE_UNKNOWN_APP_SOURCES / ACTION_MANAGE_OVERLAY_PERMISSION),
    // never the generic App info page - recent Android releases hide the
    // "Install unknown apps" toggle there, so the user would have to hunt for
    // it. Whichever permission the device already grants (some versions grant
    // one of the two by default) is skipped without any UI, so only the missing
    // permission is prompted.
    // -------------------------------------------------------------------------

    /** Permission kind ids shared with the JS layer. */
    private static final String PERMISSION_KIND_INSTALL = "install";
    private static final String PERMISSION_KIND_OVERLAY = "overlay";

    /** Pending JS call while the native permission flow is running (main thread). */
    private PluginCall permissionCall;
    /** True while the flow waits for the user to come back from Settings. */
    private volatile boolean awaitingPermissionSettings;
    /** Permission kinds still to handle, in order (first entry = current step). */
    private final Deque<String> pendingPermissionKinds = new ArrayDeque<>();
    /** False when the JS layer renders its own permission UI (no native dialog). */
    private boolean permissionShowNativeDialog = true;

    /**
     * NATIVE permission prompt for BOTH special permissions, shown as TWO
     * separate popups (one per missing permission, in order): "Install unknown
     * apps" first (required to install any update), then "Display over other
     * apps" (best-effort auto-reopen helper). Each popup is a plain Android
     * AlertDialog drawn with the host app's theme + the app's own logo, so it
     * looks like a system permission popup in every project, and its Continue
     * button opens the EXACT Settings page of that permission - the user never
     * has to find the toggle in the Settings tree.
     *
     * <p>Permissions that are already granted (some Android versions grant one
     * of the two by default) are skipped without any UI, so typically only ONE
     * popup is shown. Resolves once with the final
     * {@code { canInstall, canDrawOverlays, ready, canUpdate }} status.
     * Declining ("Not now", or coming back from Settings without granting)
     * resolves with the current state - it never rejects.</p>
     *
     * <p>Options: {@code showNativeDialog} (default true) - false draws no
     * dialog at all and resolves immediately, so a project can render its own
     * JS popup and drive Settings through
     * {@link #openInstallPermissionSettings} / {@link #openOverlayPermissionSettings};
     * {@code permissions} - restrict the flow to a subset; per-permission copy
     * overrides via the nested {@code install} / {@code overlay} objects; shared
     * copy overrides {@code title}, {@code message}, {@code confirmText},
     * {@code cancelText}.</p>
     */
    @PluginMethod
    public void requestUpdatePermissions(PluginCall call) {
        startPermissionFlow(call, null);
    }

    /**
     * NATIVE permission prompt for the "Install unknown apps" permission ONLY
     * (required to install an update). Same dialog/Settings-page behaviour and
     * options as {@link #requestUpdatePermissions}.
     */
    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        startPermissionFlow(call, PERMISSION_KIND_INSTALL);
    }

    /**
     * NATIVE permission prompt for the "Display over other apps" permission
     * ONLY (best-effort auto-reopen helper; the update works without it via the
     * tap-to-open notification fallback). Same dialog/Settings-page behaviour
     * and options as {@link #requestUpdatePermissions}.
     */
    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        startPermissionFlow(call, PERMISSION_KIND_OVERLAY);
    }

    /**
     * Shared entry point of every permission prompt: builds the queue of
     * permission kinds to handle and starts the (main-thread) flow.
     *
     * @param singleKind {@code null} for the combined flow, else the single
     *                   permission this call should handle
     */
    private void startPermissionFlow(PluginCall call, String singleKind) {
        if (permissionCall != null) {
            call.reject("A permission request is already in progress");
            return;
        }
        permissionCall = call;
        permissionShowNativeDialog =
                !Boolean.FALSE.equals(call.getBoolean("showNativeDialog", Boolean.TRUE));
        pendingPermissionKinds.clear();
        if (singleKind != null) {
            pendingPermissionKinds.add(singleKind);
        } else {
            JSONArray requested = call.getArray("permissions");
            if (requested != null && requested.length() > 0) {
                for (int i = 0; i < requested.length(); i++) {
                    String kind = normalizePermissionKind(requested.optString(i, null));
                    if (kind != null && !pendingPermissionKinds.contains(kind)) {
                        pendingPermissionKinds.add(kind);
                    }
                }
            }
            if (pendingPermissionKinds.isEmpty()) {
                // Required permission first, best-effort helper second.
                pendingPermissionKinds.add(PERMISSION_KIND_INSTALL);
                pendingPermissionKinds.add(PERMISSION_KIND_OVERLAY);
            }
        }
        mainHandler.post(() -> continuePermissionFlow(false));
    }

    /** Maps a JS permission kind ("install" / "overlay") to its id, or null. */
    private static String normalizePermissionKind(String kind) {
        if (kind == null) return null;
        String value = kind.trim().toLowerCase(Locale.US);
        if (PERMISSION_KIND_INSTALL.equals(value)) return PERMISSION_KIND_INSTALL;
        if (PERMISSION_KIND_OVERLAY.equals(value)) return PERMISSION_KIND_OVERLAY;
        return null;
    }

    /**
     * Walks the pending permission queue. Every permission that is already
     * granted - or not required on this Android version - is skipped without any
     * UI, so when the device grants one of the two by default only the missing
     * one is prompted.
     *
     * <p>When a permission is missing its own native dialog is shown; Continue
     * opens that permission's Settings page and the flow resumes in
     * {@link #handleOnResume()}. Each permission is prompted at most once per
     * flow: coming back WITHOUT granting resolves the call (no nagging - the
     * prompt runs again on the next launch), coming back WITH the grant moves on
     * to the next missing permission.</p>
     *
     * @param returnedFromSettings true when resuming after a Settings trip
     */
    private void continuePermissionFlow(boolean returnedFromSettings) {
        if (permissionCall == null) return;
        if (returnedFromSettings) {
            String handled = pendingPermissionKinds.peek();
            if (handled != null && !isPermissionGranted(handled)) {
                // Not granted on this trip: resolve with the current state
                // instead of re-showing the same dialog.
                finishPermissionFlow();
                return;
            }
            pendingPermissionKinds.poll();
        }
        while (!pendingPermissionKinds.isEmpty()) {
            String kind = pendingPermissionKinds.peek();
            if (isPermissionGranted(kind)) {
                pendingPermissionKinds.poll();
                continue;
            }
            if (!permissionShowNativeDialog) {
                // The JS layer renders its own popup and drives Settings itself
                // (openInstallPermissionSettings / openOverlayPermissionSettings).
                finishPermissionFlow();
                return;
            }
            showPermissionDialog(kind);
            return;
        }
        finishPermissionFlow();
    }

    /** True when the given permission is usable right now (or not needed here). */
    private boolean isPermissionGranted(String kind) {
        return PERMISSION_KIND_OVERLAY.equals(kind)
                ? canDrawOverlaysNow()
                : canRequestInstalls();
    }

    /**
     * The native popup of ONE permission: host-app theme, the app's own logo and
     * optional copy overrides - so it renders like a system permission popup in
     * every consuming app, with no per-project UI. Continue opens the EXACT
     * Settings page of that permission (see
     * {@link #openPermissionSettings(String)}); "Not now" resolves the flow
     * right away.
     *
     * @param kind {@link #PERMISSION_KIND_INSTALL} or
     *             {@link #PERMISSION_KIND_OVERLAY}
     */
    private void showPermissionDialog(final String kind) {
        final PluginCall call = permissionCall;
        if (call == null) return;
        final Activity activity = getActivity();
        if (activity == null) {
            // No UI to prompt with - report the current state instead of hanging.
            finishPermissionFlow();
            return;
        }

        final boolean overlay = PERMISSION_KIND_OVERLAY.equals(kind);
        final Context context = getContext();
        final String appName = context
                .getApplicationInfo()
                .loadLabel(context.getPackageManager())
                .toString();
        // Per-permission copy overrides win over the shared ones, which win
        // over the built-in defaults below.
        JSObject specific = null;
        try {
            specific = call.getObject(overlay ? "overlay" : "install");
        } catch (Exception ignored) {
            // Malformed override - fall back to the shared copy.
        }
        final String title = firstNonEmpty(
                readCopy(specific, call, "title"),
                overlay ? "Allow display over other apps" : "Allow app installs");
        final String message = firstNonEmpty(
                readCopy(specific, call, "message"),
                overlay
                        ? "Allow \"" + appName + "\" to display over other apps.\n\n"
                                + "This lets the app reopen itself automatically right "
                                + "after an update is installed. The update itself works "
                                + "without it.\n\n"
                                + "Tap Continue and enable \"Allow display over other "
                                + "apps\" (or \"Display over other apps\") on the next "
                                + "screen."
                        : "Allow \"" + appName + "\" to install app updates.\n\n"
                                + "This permission is required before the app can install "
                                + "an update.\n\n"
                                + "Tap Continue and enable \"Allow from this source\" (or "
                                + "\"Install unknown apps\") on the next screen.");
        final String confirmText = firstNonEmpty(
                readCopy(specific, call, "confirmText"), "Continue");
        final String cancelText = firstNonEmpty(
                readCopy(specific, call, "cancelText"), "Not now");

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
                                (dialog, which) -> openPermissionSettings(kind))
                        .setNegativeButton(
                                cancelText,
                                (dialog, which) -> finishPermissionFlow())
                        .show();
            } catch (Exception ex) {
                Log.w(TAG, "Unable to show the " + kind + " permission dialog", ex);
                finishPermissionFlow();
            }
        });
    }

    /** Reads a copy override from the per-permission object, then the shared ones. */
    private static String readCopy(JSObject specific, PluginCall call, String key) {
        try {
            if (specific != null) {
                String value = specific.getString(key);
                if (value != null && !value.trim().isEmpty()) return value;
            }
            return call.getString(key);
        } catch (Exception ignored) {
            return null;
        }
    }

    /**
     * Opens the EXACT Settings page of ONE permission and parks the flow until
     * the user comes back ({@link #handleOnResume()} re-checks it):
     *
     * <ul>
     *   <li><b>install</b> - {@code ACTION_MANAGE_UNKNOWN_APP_SOURCES} with this
     *       app's package (Android 8+), the page holding the "Allow from this
     *       source" toggle. Below Android 8 the permission is not required (see
     *       {@link #canRequestInstalls()}).</li>
     *   <li><b>overlay</b> - {@code ACTION_MANAGE_OVERLAY_PERMISSION} with this
     *       app's package (Android 6+), the "Display over other apps" page.</li>
     * </ul>
     *
     * <p>Only if that activity cannot be opened (OEM without that Settings
     * screen) the redirect falls back to the app's generic App info page -
     * recent Android releases hide the "Install unknown apps" toggle there,
     * which is exactly why the specific page is used first.</p>
     */
    private void openPermissionSettings(String kind) {
        if (!openPermissionSettingsPage(kind) && !openAppInfoSettings()) {
            finishPermissionFlow();
            return;
        }
        awaitingPermissionSettings = true;
    }

    /** Opens the permission-specific Settings page; false when unavailable. */
    private boolean openPermissionSettingsPage(String kind) {
        try {
            Uri packageUri = Uri.parse("package:" + getContext().getPackageName());
            Intent intent = null;
            if (PERMISSION_KIND_OVERLAY.equals(kind)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, packageUri);
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri);
            }
            if (intent == null) return false;
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivitySafely(intent);
            return true;
        } catch (Exception ex) {
            Log.w(TAG, "Unable to open the " + kind + " permission settings", ex);
            return false;
        }
    }

    /** Last-resort redirect: this app's generic App info page. */
    private boolean openAppInfoSettings() {
        try {
            Intent intent = new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivitySafely(intent);
            return true;
        } catch (Exception ex) {
            Log.w(TAG, "Unable to open the App info page", ex);
            return false;
        }
    }

    /** Resolves the pending JS call with the final permission status. */
    private void finishPermissionFlow() {
        awaitingPermissionSettings = false;
        permissionShowNativeDialog = true;
        pendingPermissionKinds.clear();
        PluginCall call = permissionCall;
        permissionCall = null;
        if (call == null) return;
        call.resolve(buildPermissionStatus());
    }

    /** Shared permission payload: {@code { canInstall, canDrawOverlays, ready, canUpdate }}. */
    private JSObject buildPermissionStatus() {
        boolean canInstall = canRequestInstalls();
        boolean canOverlay = canDrawOverlaysNow();
        JSObject result = new JSObject();
        result.put("canInstall", canInstall);
        result.put("canDrawOverlays", canOverlay);
        result.put("ready", canInstall && canOverlay);
        // Only "install unknown apps" is required to install an update; the
        // overlay helper is best effort (without it the app still comes back
        // through the tap-to-open notification).
        result.put("canUpdate", canInstall);
        return result;
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
     * One-shot readiness check for the pre-update gate (no dialog, no Settings
     * trip): {@code { canInstall, canDrawOverlays, ready, canUpdate }} - see
     * {@link #requestUpdatePermissions} / {@link #requestInstallPermission} /
     * {@link #requestOverlayPermission} for the prompting flow.
     */
    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        call.resolve(buildPermissionStatus());
    }

    /**
     * One-shot check of the "Install unknown apps" permission only (no dialog):
     * {@code { granted, required }}. `required` is false below Android 8, where
     * the OS does not expose a per-app toggle.
     */
    @PluginMethod
    public void checkInstallPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", canRequestInstalls());
        result.put("required", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O);
        call.resolve(result);
    }

    /**
     * One-shot check of the "Display over other apps" permission only (no
     * dialog): {@code { granted, required }}. `required` is false below
     * Android 6, where the permission is granted at install time.
     */
    @PluginMethod
    public void checkOverlayPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", canDrawOverlaysNow());
        result.put("required", Build.VERSION.SDK_INT >= Build.VERSION_CODES.M);
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
