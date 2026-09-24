import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
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
   * `{ canInstall, canDrawOverlays, ready }`. Neither permission can be
   * granted programmatically - both need a user toggle in Settings - so the
   * JS layer runs the NATIVE dialog flow below and only offers the APK
   * update popup once `ready` is true (install permission required, overlay
   * best-effort for auto-reopen; the update itself works without overlay via
   * the tap-to-open notification fallback).
   */
  getPermissionStatus(): Promise<ApkPermissionStatus>;

  /**
   * NATIVE permission prompt: ONE Android dialog that lists BOTH special
   * permissions together ("Install unknown apps" + "Display over other
   * apps"), built from the host app's own theme and logo so it looks like a
   * system permission popup in every project - no per-project UI needed.
   * Continue opens the app's **App info page**, where both toggles live
   * (Android 8+ lists "Install unknown apps", Android 6+ lists "Display over
   * other apps"), so the user enables both in ONE place and returns once.
   * Resolves with the final `{ canInstall, canDrawOverlays, ready }`.
   */
  requestUpdatePermissions(
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
