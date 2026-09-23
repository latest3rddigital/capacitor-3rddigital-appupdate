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
