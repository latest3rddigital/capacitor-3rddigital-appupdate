import type { PluginListenerHandle } from "@capacitor/core";
import { registerPlugin } from "@capacitor/core";
import type {
  ApkAppInfo,
  ApkCanInstallResult,
  ApkCanNotifyResult,
  ApkDownloadResult,
  ApkInstallResult,
  ApkInstallStateInfo,
  ApkNotificationPermissionResult,
  ApkPermissionPromptOptions,
  ApkPermissionStatus,
  ApkSinglePermissionResult,
  ApkUpdateProgress,
} from "./apkTypes.js";

/**
 * Native Android plugin interface for the APK update flow.
 *
 * The plugin lives in this package under `android/` and is registered as
 * `ApkUpdater`. It is automatically wired into the consumer app's Android
 * project by `npx cap sync` (via the `capacitor.android` field in
 * package.json).
 *
 * This layer is intentionally UI-free: it only reports state/progress and
 * the consuming project decides how to render it (same pattern as the
 * bundle/AppUpdate flow).
 */
export interface ApkUpdaterPluginInterface {
  /**
   * Installed app info (packageName, versionName, versionCode, debuggable).
   * `debuggable` mirrors ApplicationInfo.FLAG_DEBUGGABLE so the JS layer can
   * refuse a debug-APK update on a release install without extra plugins.
   */
  getAppInfo(): Promise<ApkAppInfo>;

  /**
   * One-shot readiness check for the pre-update gate:
   * `{ canInstall, canDrawOverlays, ready, canUpdate }`. Neither permission can
   * be granted programmatically - both need a user toggle in Settings - so the
   * JS layer runs the NATIVE dialog flow below and only offers the APK update
   * popup once `canUpdate` is true (install permission required; overlay is
   * best-effort for auto-reopen, the update works without it via the
   * tap-to-open notification fallback).
   */
  getPermissionStatus(): Promise<ApkPermissionStatus>;

  /**
   * Checks the "Install unknown apps" permission only (no dialog, no Settings
   * trip). `required` is false below Android 8, where the OS has no per-app
   * toggle.
   */
  checkInstallPermission(): Promise<ApkSinglePermissionResult>;

  /**
   * Checks the "Display over other apps" permission only (no dialog, no
   * Settings trip). `required` is false below Android 6.
   */
  checkOverlayPermission(): Promise<ApkSinglePermissionResult>;

  /**
   * NATIVE permission prompt: runs ONE Android dialog PER missing permission
   * (in order: "Install unknown apps" then "Display over other apps"), each
   * built from the host app's own theme and logo so it looks like a system
   * permission popup in every project - no per-project UI needed. The Continue
   * button of each popup opens the **exact Settings page** of that permission
   * (`ACTION_MANAGE_UNKNOWN_APP_SOURCES` / `ACTION_MANAGE_OVERLAY_PERMISSION`),
   * never the generic App info page - recent Android releases hide the "Install
   * unknown apps" toggle there. Permissions already granted (some versions
   * grant one of the two by default) are skipped, so typically only ONE popup
   * is shown. Resolves with the final `{ canInstall, canDrawOverlays, ready,
   * canUpdate }`.
   *
   * Pass `showNativeDialog: false` to draw no dialog at all and just resolve the
   * current status (your own JS popup can drive Settings through
   * `openInstallPermissionSettings()` / `openOverlayPermissionSettings()`).
   */
  requestUpdatePermissions(
    options?: ApkPermissionPromptOptions,
  ): Promise<ApkPermissionStatus>;

  /**
   * NATIVE permission prompt for the "Install unknown apps" permission only
   * (the one REQUIRED to install an update). Continue opens that permission's
   * own Settings page. Same options as `requestUpdatePermissions`.
   */
  requestInstallPermission(
    options?: ApkPermissionPromptOptions,
  ): Promise<ApkPermissionStatus>;

  /**
   * NATIVE permission prompt for the "Display over other apps" permission only
   * (best-effort auto-reopen helper). Continue opens that permission's own
   * Settings page. Same options as `requestUpdatePermissions`.
   */
  requestOverlayPermission(
    options?: ApkPermissionPromptOptions,
  ): Promise<ApkPermissionStatus>;

  /**
   * Whether the app may install APKs ("install unknown apps" permission).
   * Android never grants this silently - the user must flip it in Settings.
   */
  canInstall(): Promise<ApkCanInstallResult>;

  /** Opens the "Install unknown apps" Settings page for this app. */
  openInstallPermissionSettings(): Promise<void>;

  /**
   * Opens the "Display over other apps" Settings page for this app
   * (`ACTION_MANAGE_OVERLAY_PERMISSION` + package, Android 6+).
   */
  openOverlayPermissionSettings(): Promise<void>;

  /**
   * Whether the "Update installed - tap to open" fallback notification can be
   * shown right now (always true on Android 12 and below).
   */
  canNotify(): Promise<ApkCanNotifyResult>;

  /**
   * Asks for the notification permission with the standard in-app system
   * dialog on Android 13+ (no Settings trip). Resolves immediately with
   * `{ granted: true }` on Android 12 and below.
   */
  requestNotificationPermission(): Promise<ApkNotificationPermissionResult>;

  /**
   * Downloads the APK from `url` (S3) and reports progress via the
   * `downloadProgress` event. Resolves with the local file path.
   */
  download(options: {
    url: string;
    versionName?: string;
    versionCode?: number;
  }): Promise<ApkDownloadResult>;

  /**
   * Installs the downloaded APK via the system PackageInstaller (silent
   * self-update on Android 12+ when allowed) with fallback to the system
   * installer dialog. Outcomes are emitted through the `installState` event
   * (`staging` includes a 0-100 percent while the APK is written into the
   * install session, then `pending_user_action` / `success` / `failure`).
   *
   * When the "install unknown apps" permission is missing, the system
   * installer shows its own inline permission prompt and resumes the install
   * by itself once granted - no round trip back to the app is required.
   */
  install(options?: { filePath?: string }): Promise<ApkInstallResult>;

  /** Relaunches the app and kills the current process. */
  restartApp(): Promise<void>;

  addListener(
    eventName: "downloadProgress",
    listenerFunc: (progress: ApkUpdateProgress) => void,
  ): Promise<PluginListenerHandle> & PluginListenerHandle;

  addListener(
    eventName: "installState",
    listenerFunc: (state: ApkInstallStateInfo) => void,
  ): Promise<PluginListenerHandle> & PluginListenerHandle;

  removeAllListeners(): Promise<void>;
}

export const ApkUpdater =
  registerPlugin<ApkUpdaterPluginInterface>("ApkUpdater");
