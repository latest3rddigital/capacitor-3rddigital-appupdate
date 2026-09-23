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
   * Whether the app may install APKs ("install unknown apps" permission).
   * Android never grants this silently - the user must flip it in Settings.
   */
  canInstall(): Promise<ApkCanInstallResult>;

  /** Opens the OS settings so the user can grant the install permission. */
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
