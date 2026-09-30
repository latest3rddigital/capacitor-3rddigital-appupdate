// ---------------------------------------------------------------------------
// Types for the Android in-app APK update flow.
//
// These are intentionally separate from the OTA bundle flow types (types.ts)
// so the APK flow can evolve without affecting bundle/iOS updates.
// ---------------------------------------------------------------------------

/** Metadata about an available APK update, returned by the update server. */
export interface ApkUpdateInfo {
  availableVersionCode: number;
  availableVersionName: string;
  url: string;
  forceUpdate: boolean;
  apkId: string;
  /**
   * Build markers forwarded by `appupdate-apk` at upload time (and echoed by
   * the server) so a release install can refuse a debug APK client-side too.
   */
  buildType?: "release" | "debug" | string;
  isDebugApk?: boolean;
}

/** Gate state for running forced OTA updates after forced APK updates. */
export type ApkUpdatePriority = "checking" | "blocked" | "clear";

/**
 * Unified phase of the whole update lifecycle (permission → download →
 * install → confirm → done), used to drive progress UIs.
 */
export type ApkUpdatePhase =
  | "idle"
  | "permission"
  | "downloading"
  | "installing"
  | "confirming"
  | "success"
  | "failure";

/**
 * Progress payload emitted by the native plugin while downloading the APK.
 */
export interface ApkUpdateProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  versionName?: string;
}

/**
 * Unified progress info across the whole update lifecycle. `percent` is an
 * overall 0-100 value (download 0-90, session staging 90-99, confirmed 99,
 * success 100) so a single progress bar can cover the complete journey.
 * `downloadPercent` keeps the raw 0-100 download value.
 */
export interface ApkProgressInfo {
  phase: ApkUpdatePhase;
  percent: number;
  downloadPercent: number;
  bytesWritten?: number;
  totalBytes?: number;
  message?: string;
}

export type ApkInstallState =
  | "staging"
  | "pending_user_action"
  | "success"
  | "failure";

/** Payload emitted by the native plugin when the install status changes. */
export interface ApkInstallStateInfo {
  state: ApkInstallState;
  message?: string;
  /** Staging progress (0-100) while the APK is written into the session. */
  percent?: number;
}

export interface ApkAppInfo {
  packageName: string;
  versionName: string;
  versionCode: number;
  /** True when this build is debuggable (debug signing). */
  debuggable?: boolean;
}

/**
 * The two special Android permissions the APK flow can check/prompt for:
 *
 * - `"install"` - "Install unknown apps" (`REQUEST_INSTALL_PACKAGES`). REQUIRED
 *   to install any APK; the update flow cannot run without it.
 * - `"overlay"` - "Display over other apps" (`SYSTEM_ALERT_WINDOW`). Best-effort
 *   helper so the app can reopen itself after the OS kills it for the install;
 *   without it the app still comes back via the tap-to-open notification.
 */
export type ApkPermissionKind = "install" | "overlay";

/**
 * Copy overrides for ONE of the native permission popups. Every key falls back
 * to the shared `ApkPermissionPromptOptions` value and then to the built-in
 * default copy.
 */
export interface ApkPermissionPromptCopy {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
}

export interface ApkPermissionStatus {
  canInstall: boolean;
  canDrawOverlays: boolean;
  /**
   * True only when BOTH special permissions are granted. Informational - the
   * update itself only needs `canUpdate`.
   */
  ready: boolean;
  /**
   * True when the APK update itself may run: it only needs the "Install unknown
   * apps" permission. "Display over other apps" is a best-effort auto-reopen
   * helper, so a missing overlay never blocks the update. Optional so the layer
   * still works against an older native plugin (defaults to `canInstall`).
   */
  canUpdate?: boolean;
}

/** Result of the per-permission check APIs (no dialog, no Settings trip). */
export interface ApkSinglePermissionResult {
  /** True when this permission is granted right now. */
  granted: boolean;
  /** False when this Android version does not need the permission at all. */
  required: boolean;
}

/**
 * Options for the NATIVE permission popups. Each prompt is ONE Android dialog
 * (host app theme + the app's own logo, so it looks like a system permission
 * popup - no per-project UI needed) whose Continue button opens the EXACT
 * Settings page of that permission, so the user never has to find the toggle.
 *
 * Both permissions can also be handled from JS: pass `showNativeDialog: false`
 * to get a plain status resolve, then render your own popup and call
 * `openApkPermissionSettings(kind)` / `requestApkPermission(kind, ...)`.
 */
export interface ApkPermissionPromptOptions extends ApkPermissionPromptCopy {
  /**
   * When false the plugin draws NO dialog: it resolves immediately with the
   * current status so your own JS UI/popup can drive the flow. Default true.
   */
  showNativeDialog?: boolean;
  /**
   * Which permissions the combined `requestUpdatePermissions()` handles, in
   * order. Default `["install", "overlay"]`; already granted ones are skipped.
   */
  permissions?: ApkPermissionKind[];
  /** Copy overrides for the "Install unknown apps" popup. */
  install?: ApkPermissionPromptCopy;
  /** Copy overrides for the "Display over other apps" popup. */
  overlay?: ApkPermissionPromptCopy;
}

export interface ApkCanInstallResult {
  canInstall: boolean;
}

export interface ApkCanNotifyResult {
  canNotify: boolean;
}

export interface ApkNotificationPermissionResult {
  granted: boolean;
}

export interface ApkDownloadResult {
  path: string;
  size: number;
}

export interface ApkInstallResult {
  status: string;
  message?: string;
}

export interface ApkUpdaterModalProps {
  visible: boolean;
  updateInfo: ApkUpdateInfo | null;
  onConfirm: () => void;
  onCancel: () => void;
  customUI?: (
    info: ApkUpdateInfo,
    onConfirm: () => void,
    onCancel: () => void,
  ) => React.ReactNode;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  showProgress?: boolean;
  progress?: number;
  styles?: {
    overlay?: React.CSSProperties;
    container?: React.CSSProperties;
    title?: React.CSSProperties;
    message?: React.CSSProperties;
    progressBar?: React.CSSProperties;
    progressFill?: React.CSSProperties;
    buttonRow?: React.CSSProperties;
    confirmButton?: React.CSSProperties;
    cancelButton?: React.CSSProperties;
  };
}
