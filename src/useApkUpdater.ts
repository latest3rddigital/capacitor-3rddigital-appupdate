import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { useEffect, useRef, useState } from "react";
import { ApkUpdater } from "./apkPlugin.js";
import type {
  ApkInstallStateInfo,
  ApkPermissionKind,
  ApkPermissionPromptOptions,
  ApkPermissionStatus,
  ApkProgressInfo,
  ApkUpdateInfo,
  ApkUpdatePhase,
  ApkUpdatePriority,
} from "./apkTypes.js";

/**
 * Written when an update attempt starts. Consumed on the next launch: if the
 * installed versionCode reached the stored target, the update really
 * succeeded - that is what triggers `onUpdateSuccess` /
 * `apkUpdateJustCompleted`. The OS kills the process during the install, so
 * the result can only be evaluated on the fresh launch (same idea as the
 * bundle flow's `UPDATE_IN_PROGRESS` flag).
 */
const APK_UPDATE_IN_PROGRESS_KEY = "APK_UPDATE_IN_PROGRESS";

/**
 * Persisted only while waiting for the "install unknown apps" permission so
 * the flow resumes automatically - even after process death - the moment the
 * permission is granted.
 */
const APK_UPDATE_PENDING_KEY = "APK_UPDATE_PENDING";

/** Phases during which the update actively runs (drive your own UI from it). */
const UPDATING_PHASES: ApkUpdatePhase[] = [
  "permission",
  "downloading",
  "installing",
  "confirming",
];

/** Target stored for an update attempt started in a previous run. */
interface StoredUpdateAttempt {
  versionCode: number;
  versionName?: string;
  apkId?: string;
}

/**
 * Reads + clears the stored attempt flag.
 *
 * @param installedVersionCode current installed versionCode, or `null` to
 *        skip the version verification (used when a live `success` event
 *        arrives, where the package is already replaced).
 * @returns the stored attempt when it can be verified (or verification is
 *        skipped); an interrupted/stale flag is cleared and reported as null.
 */
function consumeStoredAttempt(
  installedVersionCode: number | null,
): StoredUpdateAttempt | null {
  try {
    const raw = localStorage.getItem(APK_UPDATE_IN_PROGRESS_KEY);
    if (!raw) return null;
    // Consumed either way - a stale/interrupted flag must not leak.
    localStorage.removeItem(APK_UPDATE_IN_PROGRESS_KEY);
    const parsed = JSON.parse(raw); // legacy "true" format -> parsed unusable
    const versionCode = Number(parsed?.versionCode);
    if (!Number.isFinite(versionCode) || versionCode <= 0) return null;
    const attempt: StoredUpdateAttempt = {
      versionCode,
      versionName: parsed?.versionName ? String(parsed.versionName) : undefined,
      apkId: parsed?.apkId ? String(parsed.apkId) : undefined,
    };
    if (
      installedVersionCode === null ||
      installedVersionCode >= attempt.versionCode
    ) {
      return attempt;
    }
    return null; // interrupted before the install completed
  } catch {
    return null;
  }
}

function readPendingInfo(): ApkUpdateInfo | null {
  try {
    const raw = localStorage.getItem(APK_UPDATE_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.url && Number(parsed?.availableVersionCode)
      ? (parsed as ApkUpdateInfo)
      : null;
  } catch {
    return null;
  }
}

function persistPendingInfo(info: ApkUpdateInfo) {
  try {
    localStorage.setItem(APK_UPDATE_PENDING_KEY, JSON.stringify(info));
  } catch {
    // Storage unavailable - the in-memory ref still covers this session.
  }
}

function normalizeApkBaseUrl(url?: string) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

/** True when the server marks this update as coming from a debug APK. */
function isDebugApkUpdate(info: ApkUpdateInfo): boolean {
  if (info.isDebugApk === true) return true;
  return String(info.buildType || "").toLowerCase() === "debug";
}

function clearPendingInfo() {
  try {
    localStorage.removeItem(APK_UPDATE_PENDING_KEY);
  } catch {
    // ignore
  }
}

/**
 * Android-only hook for the in-app APK update flow.
 *
 * This hook is intentionally UI-free: it only exposes states/props/callbacks
 * and the consuming project renders its own modal/progress screen - the same
 * pattern as `useCapacitorUpdater` + the AppUpdate UI.
 *
 * Permission flow (all Android versions):
 * 1. On app open, call `ensureApkPermissions()` (or read
 *    `apkPermissionStatus`). It checks BOTH "Install unknown apps"
 *    (REQUIRED to install any APK) and "Display over other apps"
 *    (best-effort helper so the app can reopen itself after the OS kills it
 *    for the install). Neither can be granted programmatically, so the
 *    plugin shows its NATIVE popups - ONE Android dialog PER missing
 *    permission, built from the host app's theme and logo (they look like
 *    system permission popups, so no per-project UI is needed). Each popup's
 *    Continue button opens the **exact Settings page of that permission**
 *    (`ACTION_MANAGE_UNKNOWN_APP_SOURCES` / `ACTION_MANAGE_OVERLAY_PERMISSION`),
 *    so the user never has to hunt for the toggle - the generic App info page
 *    hides it on recent Android releases. Whichever permission the device
 *    already grants (some versions grant one of the two by default) is
 *    skipped, so typically only ONE popup appears.
 *    The cycle repeats on EVERY app open until each permission is granted -
 *    declining ("Not now") or killing the app never dismisses it for good,
 *    and a relaunch that already passes the gate still pops whatever is
 *    missing (without blocking the update flow).
 *    The update popup (`isApkUpdateModalVisible`) only appears once the
 *    permission gate passes, so the user never sees "update available"
 *    before the app is actually able to install it.
 * 2. Native popups can be turned off (`nativePermissionPrompt: false`) - then
 *    this hook only CHECKS and your own JS popup drives the flow through
 *    `requestApkPermission(kind)` / `checkApkPermission(kind)` /
 *    `openApkPermissionSettings(kind)`.
 * 3. `handleApkUpdate()` downloads the APK (progress events), then commits
 *    the PackageInstaller session. After the install the OS kills the
 *    process; on relaunch the stored target versionCode is compared with the
 *    installed one and `onUpdateSuccess` / `apkUpdateJustCompleted` fire
 *    exactly once ("App updated successfully" - same as bundle flow).
 *
 * The APK flow is blocked without the install permission, but the bundle
 * (OTA) flow never is: when the user does not grant the permissions,
 * `apkUpdatePriority` is released to "clear" (unless
 * `keepBundleUpdatesBlockedWithoutApkPermission` is set) so `useCapacitorUpdater`
 * keeps working without these permissions.
 *
 * Does nothing on iOS or web.
 */
export function useApkUpdater(options?: {
  baseUrl: string;
  projectKey?: string;
  packageName?: string;
  apiKey?: string;
  /**
   * Safety net the CLI/server already enforce: a release (non-debuggable)
   * install ignores any update flagged as a debug APK (default true).
   * Disable only when you fully control both sides.
   */
  rejectDebugApkOnRelease?: boolean;
  /** Called when such an update is blocked client-side. */
  onBlockedUpdate?: (info: ApkUpdateInfo, reason: string) => void;
  /** Called when the user comes back with the required permissions granted. */
  onPermissionsGranted?: () => void;
  /** Called after every permission check/prompt with the fresh status. */
  onPermissionStatusChange?: (status: ApkPermissionStatus) => void;
  /**
   * Enables/disables the plugin's NATIVE permission popups (default true).
   * When false `ensureApkPermissions()` only CHECKS (no dialog, no Settings
   * trip) - render your own JS popup and call `openApkPermissionSettings(kind)`
   * from it. `requestApkPermission(kind, { showNativeDialog: true })` still
   * opens the native one on demand.
   */
  nativePermissionPrompt?: boolean;
  /** Copy overrides for the native permission popups (title/message/buttons). */
  permissionPromptOptions?: ApkPermissionPromptOptions;
  /**
   * Which permissions must be granted before the APK update may start.
   * Default `"install"`: only the permission that is actually required -
   * "Display over other apps" is a best-effort auto-reopen helper and never
   * blocks the update (it is still prompted for). Use `"both"` for the strict
   * old gate.
   */
  requiredPermissions?: "install" | "both";
  /**
   * What `apkUpdatePriority` does when a forced APK update cannot run because
   * the permissions were not granted. Default `false`: the gate is released
   * ("clear") so the bundle/OTA update and the app keep working WITHOUT these
   * permissions. `true` keeps OTA paused until the forced APK is installed.
   */
  keepBundleUpdatesBlockedWithoutApkPermission?: boolean;
  /** @deprecated Progress events are always delivered now; kept for compatibility. */
  showProgress?: boolean;
  /** Called with the overall 0-100 progress while downloading/installing. */
  onProgress?: (percent: number, info: ApkProgressInfo) => void;
  /** Called whenever the update phase changes. */
  onPhaseChange?: (phase: ApkUpdatePhase, info: ApkProgressInfo) => void;
  onInstallStateChange?: (state: ApkInstallStateInfo) => void;
  /** @deprecated Use onPermissionsGranted; kept for compatibility. */
  onInstallPermissionGranted?: () => void;
  /**
   * Called once on the launch after a successful update (the process was
   * killed by the install). Use it to show your success message, e.g.
   * `message.success("App updated successfully")` - like the AppUpdate flow.
   */
  onUpdateSuccess?: (info: {
    versionCode: number;
    versionName?: string;
  }) => void;
  /**
   * Permission gate for the APK update flow. Kept for compatibility; the flow
   * now ALWAYS pre-checks the permissions on app open (install-unknown-apps
   * REQUIRED, overlay best-effort) using the plugin's NATIVE popups and only
   * shows the update popup once the gate passes.
   * @deprecated Always behaves as `true`; kept so existing code compiles.
   */
  preflightInstallPermission?: boolean;
}) {
  const [apkUpdateInfo, setApkUpdateInfo] = useState<ApkUpdateInfo | null>(
    null,
  );
  const [apkUpdatePriority, setApkUpdatePriority] = useState<ApkUpdatePriority>(
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
      ? "checking"
      : "clear",
  );
  const [isApkUpdateModalVisible, setApkUpdateModalVisible] = useState(false);
  const [apkProgress, setApkProgress] = useState<number>(0);
  const [apkPhase, setApkPhase] = useState<ApkUpdatePhase>("idle");
  const [apkProgressInfo, setApkProgressInfo] = useState<ApkProgressInfo>({
    phase: "idle",
    percent: 0,
    downloadPercent: 0,
  });
  const [apkError, setApkError] = useState<string | null>(null);
  const [apkUpdateJustCompleted, setApkUpdateJustCompleted] = useState(false);
  const [installState, setInstallState] = useState<ApkInstallStateInfo | null>(
    null,
  );
  const [canInstall, setCanInstall] = useState<boolean | null>(null);
  const [apkPermissionStatus, setApkPermissionStatus] =
    useState<ApkPermissionStatus | null>(null);
  /**
   * True while a known APK update cannot run because its permissions are not
   * granted (the user declined or came back from Settings without enabling
   * them). The APK flow is blocked - render a "grant permissions" affordance if
   * you want - while the bundle/OTA flow is never blocked by it.
   */
  const [apkBlockedByPermission, setApkBlockedByPermission] = useState(false);

  // Refs keep the latest values available inside long-lived event listeners
  // without re-registering them on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const updateInfoRef = useRef<ApkUpdateInfo | null>(null);
  // One attempt => at most one success and one failure report (the native side
  // can emit an install failure after the JS promise already settled).
  const reportedRef = useRef<{ success: boolean; failure: boolean }>({
    success: false,
    failure: false,
  });
  // True from `handleApkUpdate()` until success/failure - blocks duplicate
  // starts (e.g. a consumer calling `handleApkUpdate()` again after the
  // permission round trip while the auto-resume already continued it).
  const updateActiveRef = useRef(false);
  // True while parked on the native permission prompt (Settings round trip).
  const awaitingPermissionRef = useRef(false);
  const pendingInfoRef = useRef<ApkUpdateInfo | null>(null);
  // Successful download of the current target, reused for instant retries
  // (e.g. after the user cancelled the system install dialog).
  const downloadCacheRef = useRef<{ key: string; path: string } | null>(null);
  const successFiredRef = useRef(false);

  // Single writer for every progress/phase update.
  const progressRef = useRef<{
    phase: ApkUpdatePhase;
    downloadPercent: number;
    stagingPercent: number;
    bytesWritten: number;
    totalBytes: number;
    message?: string;
    blended: number;
  }>({
    phase: "idle",
    downloadPercent: 0,
    stagingPercent: -1,
    bytesWritten: 0,
    totalBytes: 0,
    blended: 0,
  });

  const getHeaders = (apiKey?: string) => ({
    "Content-Type": "application/json",
    "Api-Key": apiKey ?? "",
  });

  const countApk = async (
    apkId: string,
    status: "success" | "failure",
    error?: string,
  ) => {
    if (!apkId) return;
    if (reportedRef.current[status]) return;
    reportedRef.current[status] = true;
    try {
      const data: Record<string, unknown> = { status };
      if (error) data.error = error;
      if (status === "failure") {
        const deviceinfo = await Device.getInfo();
        data.deviceInfo = {
          model: deviceinfo.model,
          brand: deviceinfo.manufacturer,
          systemName: deviceinfo.operatingSystem,
          systemVersion: deviceinfo.osVersion,
        };
      }
      await CapacitorHttp.post({
        url: `${normalizeApkBaseUrl(optionsRef.current?.baseUrl)}/apks/${apkId}/count`,
        headers: getHeaders(optionsRef.current?.apiKey),
        data,
      });
    } catch (err) {
      console.warn("[ApkUpdater] Failed to record update count:", err);
    }
  };

  /** Recomputes the overall 0-100 percent for the current phase and notifies. */
  const emitProgress = (update?: Partial<typeof progressRef.current>) => {
    const prev = progressRef.current;
    const next = { ...prev, ...update };
    let percent = prev.blended;
    switch (next.phase) {
      case "idle":
        percent = 0;
        break;
      case "downloading":
        percent = Math.round(next.downloadPercent * 0.9); // 0-90
        break;
      case "installing":
        percent =
          next.stagingPercent >= 0
            ? Math.round(90 + (next.stagingPercent * 9) / 100) // 90-99
            : 90;
        break;
      case "confirming":
        percent = 99;
        break;
      case "success":
        percent = 100;
        break;
      case "permission":
      case "failure":
        percent = prev.blended; // indeterminate wait / keep last value
        break;
    }
    next.blended = percent;
    progressRef.current = next;

    const phaseChanged = prev.phase !== next.phase;
    const info: ApkProgressInfo = {
      phase: next.phase,
      percent,
      downloadPercent: next.downloadPercent,
      bytesWritten: next.bytesWritten,
      totalBytes: next.totalBytes,
      message: next.message,
    };
    setApkProgress(percent);
    setApkPhase(next.phase);
    setApkProgressInfo(info);
    optionsRef.current?.onProgress?.(percent, info);
    if (phaseChanged) optionsRef.current?.onPhaseChange?.(next.phase, info);
  };

  /**
   * A real install success was observed (live event or detected on relaunch).
   * Fires `onUpdateSuccess` exactly once and reports the success upstream.
   */
  const fireSuccess = (stored: StoredUpdateAttempt | null) => {
    if (successFiredRef.current) return;
    successFiredRef.current = true;
    updateActiveRef.current = false;
    awaitingPermissionRef.current = false;
    pendingInfoRef.current = null;
    clearPendingInfo();
    try {
      localStorage.removeItem(APK_UPDATE_IN_PROGRESS_KEY);
    } catch {
      // ignore
    }

    const info = updateInfoRef.current;
    emitProgress({ phase: "success", stagingPercent: -1, message: undefined });
    setApkError(null);
    setApkUpdateJustCompleted(true);

    countApk(info?.apkId ?? stored?.apkId ?? "", "success");
    optionsRef.current?.onUpdateSuccess?.({
      versionCode: stored?.versionCode ?? info?.availableVersionCode ?? 0,
      versionName: stored?.versionName ?? info?.availableVersionName,
    });
  };

  /** A download/install attempt failed or the user cancelled the installer. */
  const failUpdate = (
    info: ApkUpdateInfo | null,
    message: string,
    source: "task" | "state" = "task",
  ) => {
    updateActiveRef.current = false;
    awaitingPermissionRef.current = false;
    pendingInfoRef.current = null;
    clearPendingInfo();
    try {
      localStorage.removeItem(APK_UPDATE_IN_PROGRESS_KEY);
    } catch {
      // ignore
    }
    // A user-cancelled install keeps the already downloaded APK so the retry
    // does not download everything again; anything else starts fresh.
    if (source !== "state") downloadCacheRef.current = null;

    emitProgress({ phase: "failure", message });
    setApkError(message);

    // Offer the update again so the attempt can simply be retried.
    if (info) {
      updateInfoRef.current = info;
      setApkUpdateInfo(info);
      setApkUpdateModalVisible(true);
    }
    if (info?.apkId) countApk(info.apkId, "failure", message);
    console.warn("[ApkUpdater] Update attempt failed:", message);
  };

  /**
   * Downloads the APK (unless this exact version is already cached from a
   * previous attempt) and commits the install session.
   */
  const runUpdate = async (info: ApkUpdateInfo) => {
    try {
      const cacheKey = `${info.url}|${info.availableVersionCode}`;
      let installStarted = false;

      const cached = downloadCacheRef.current;
      if (cached && cached.key === cacheKey) {
        try {
          emitProgress({
            phase: "installing",
            downloadPercent: 100,
            stagingPercent: -1,
            bytesWritten: 0,
            totalBytes: 0,
            message: undefined,
          });
          await ApkUpdater.install({ filePath: cached.path });
          installStarted = true;
        } catch {
          downloadCacheRef.current = null; // file gone/corrupt - re-download
        }
      }

      if (!installStarted) {
        emitProgress({
          phase: "downloading",
          downloadPercent: 0,
          stagingPercent: -1,
          bytesWritten: 0,
          totalBytes: 0,
          message: undefined,
        });
        const download = await ApkUpdater.download({
          url: info.url,
          versionName: info.availableVersionName,
          versionCode: info.availableVersionCode,
        });
        downloadCacheRef.current = {
          key: cacheKey,
          path: download.path,
        };
        emitProgress({
          phase: "installing",
          downloadPercent: 100,
          stagingPercent: -1,
        });
        await ApkUpdater.install({ filePath: download.path });
      }

      // Session committed - the OS owns the flow from here. If the install
      // permission is still missing, the system installer shows its inline
      // prompt and resumes by itself once the user grants it.
      emitProgress({ phase: "confirming" });
    } catch (err: any) {
      console.error("[ApkUpdater] Failed to update:", err);
      failUpdate(info, err?.message ?? "Failed to update APK.", "task");
    }
  };

  /** Normalizes the native payload (also tolerates an older native plugin). */
  const normalizePermissionStatus = (
    status: ApkPermissionStatus,
  ): ApkPermissionStatus => {
    const canInstall = !!status.canInstall;
    const canDrawOverlays = !!status.canDrawOverlays;
    return {
      ...status,
      canInstall,
      canDrawOverlays,
      ready: canInstall && canDrawOverlays,
      canUpdate: status.canUpdate ?? canInstall,
    };
  };

  const readPermissionStatus =
    async (): Promise<ApkPermissionStatus | null> => {
      if (
        !Capacitor.isNativePlatform() ||
        Capacitor.getPlatform() !== "android"
      )
        return null;
      try {
        const full = normalizePermissionStatus(
          await ApkUpdater.getPermissionStatus(),
        );
        setApkPermissionStatus(full);
        setCanInstall(full.canInstall);
        optionsRef.current?.onPermissionStatusChange?.(full);
        return full;
      } catch {
        try {
          const legacy = await ApkUpdater.canInstall();
          const full = normalizePermissionStatus({
            canInstall: legacy.canInstall,
            canDrawOverlays: true,
            ready: legacy.canInstall,
            canUpdate: legacy.canInstall,
          });
          setApkPermissionStatus(full);
          setCanInstall(legacy.canInstall);
          optionsRef.current?.onPermissionStatusChange?.(full);
          return full;
        } catch {
          return null;
        }
      }
    };

  /**
   * True when the permissions required by the current gate are granted:
   * `requiredPermissions: "install"` (default) only needs "Install unknown
   * apps"; `"both"` needs the overlay helper too. An unavailable native check
   * (null) never blocks - the update is attempted and the installer decides.
   */
  const permissionGatePassed = (
    status: ApkPermissionStatus | null | undefined,
  ): boolean => {
    if (!status) return true;
    if (optionsRef.current?.requiredPermissions === "both") return status.ready;
    return status.canUpdate ?? status.canInstall;
  };

  /**
   * The APK update cannot run without its permissions - but the bundle (OTA)
   * flow must keep working without them, so the `apkUpdatePriority` gate is
   * released (unless the consumer opted into keeping it blocked).
   */
  const releasePriorityWithoutPermissions = () => {
    if (optionsRef.current?.keepBundleUpdatesBlockedWithoutApkPermission)
      return;
    if (updateActiveRef.current) return;
    setApkUpdatePriority("clear");
  };

  /**
   * Shared "required permissions granted now" bookkeeping for EVERY grant
   * path (the native combined prompt, a single-permission prompt, and a
   * custom JS popup driving `openApkPermissionSettings` /
   * `requestApkPermission` / `checkApkPermission`): clears the blocked flag,
   * notifies the grant callbacks and continues a parked update (force →
   * straight into the progress screen, optional → popup). The awaiting/pending
   * guards are read and cleared SYNCHRONOUSLY, so racing callers
   * (appStateChange resume vs. a resolving native prompt) continue the
   * update exactly once.
   */
  const onRequiredPermissionsGranted = async () => {
    setApkBlockedByPermission(false);
    if (
      !updateActiveRef.current &&
      progressRef.current.phase === "permission"
    ) {
      emitProgress({ phase: "idle", stagingPercent: -1 });
    }
    const waiting =
      awaitingPermissionRef.current || pendingInfoRef.current != null;
    if (!waiting) return; // nothing parked waiting (e.g. app-open check)
    awaitingPermissionRef.current = false;
    const parked = pendingInfoRef.current;
    pendingInfoRef.current = null;
    clearPendingInfo();
    optionsRef.current?.onPermissionsGranted?.();
    optionsRef.current?.onInstallPermissionGranted?.();
    if (parked && !updateActiveRef.current) {
      updateInfoRef.current = parked;
      setApkUpdateInfo(parked);
      if (parked.forceUpdate) {
        // Force update: never flash the popup - start right into the
        // progress screen (no-op if an attempt is already running).
        await handleApkUpdate(parked);
      } else {
        setApkUpdateModalVisible(true);
      }
    }
  };

  /**
   * Shared "still missing a required permission" bookkeeping: the APK update
   * stays blocked (it cannot install), but the bundle/OTA flow is released so
   * the app keeps working WITHOUT these permissions - the priority is only
   * held while an APK update can actually run. A parked update KEEPS its
   * `awaitingPermissionRef` flag, so ANY later grant - foreground return from
   * Settings, a custom popup's `requestApkPermission`/`checkApkPermission`,
   * or the next prompt - continues it immediately instead of waiting for the
   * next launch.
   */
  const onRequiredPermissionsMissing = () => {
    setApkBlockedByPermission(true);
    // A parked update keeps waiting so ANY later grant (foreground return
    // from Settings, a JS request/check, the next prompt) resumes it in
    // this same session; without one there is nothing to wait for.
    awaitingPermissionRef.current = pendingInfoRef.current != null;
    releasePriorityWithoutPermissions();
    if (
      !updateActiveRef.current &&
      progressRef.current.phase === "permission"
    ) {
      emitProgress({ phase: "idle", stagingPercent: -1 });
    }
  };

  /**
   * Permission gate. Call it on app open (before showing any update UI):
   * checks BOTH "Install unknown apps" (required) and "Display over other
   * apps" (auto-reopen helper). When something is missing it runs the plugin's
   * NATIVE flow - ONE Android popup PER missing permission (host app theme +
   * the app's own logo, so they look like system permission popups in every
   * project and need no custom UI here), each Continue opening the exact
   * Settings page of that permission. Permissions the device already grants
   * (some versions grant one of the two by default) are skipped, so typically
   * only ONE popup appears. The flow keeps running on EVERY open until each
   * requested permission is granted - even when the update gate already
   * passes on "Install unknown apps" alone, the still-missing best-effort
   * permission keeps prompting (that prompt never blocks the update flow).
   *
   * Returns true only when the update may proceed. With
   * `nativePermissionPrompt: false` (or `showNativeDialog: false` here) no
   * dialog is shown at all - use the result to render your own popup and call
   * `openApkPermissionSettings(kind)`.
   */
  const ensureApkPermissions = async (override?: {
    /** Force the native popup on/off for this call (overrides the hook option). */
    showNativeDialog?: boolean;
    /** Only handle these permissions (default: both, skipping granted ones). */
    permissions?: ApkPermissionKind[];
  }): Promise<boolean> => {
    const status = await readPermissionStatus();
    if (!status) return true;
    // Permissions this flow is willing to prompt for (chain order): the call
    // override wins, then the configured prompt set, default BOTH.
    const requested: ApkPermissionKind[] =
      override?.permissions ??
      optionsRef.current?.permissionPromptOptions?.permissions ??
      ["install", "overlay"];
    const stillMissing =
      (requested.includes("install") && !status.canInstall) ||
      (requested.includes("overlay") && !status.canDrawOverlays);
    const gatePassed = permissionGatePassed(status);
    if (gatePassed && !stillMissing) {
      // Everything granted (e.g. a previous session parked the update and the
      // user enabled the permissions manually): run the shared bookkeeping so
      // a parked update continues and the wait flags are cleaned up.
      await onRequiredPermissionsGranted();
      return true;
    }
    // `gatePassed && stillMissing` = the REQUIRED permission is in but a
    // best-effort one ("Display over other apps") is not. Keep PROMPTING for
    // it - the popup must reappear on EVERY open until granted, even after a
    // relaunch that left the gate already passing - but the APK update itself
    // is NOT blocked: no parking, no apkBlockedByPermission, no "permission"
    // phase, no waiting flag (the native chain resolves itself).
    const promptOnly = gatePassed;

    const info = updateInfoRef.current;
    if (info && !promptOnly) {
      pendingInfoRef.current = info;
      persistPendingInfo(info);
    }
    const showNativeDialog =
      override?.showNativeDialog ??
      optionsRef.current?.nativePermissionPrompt !== false;
    if (!promptOnly) {
      setApkBlockedByPermission(true);
    }
    if (showNativeDialog) {
      if (!promptOnly) {
        awaitingPermissionRef.current = true;
        emitProgress({ phase: "permission" });
      }
      try {
        // Native flow: one popup per missing permission, each opening its own
        // Settings page; resolves when the user is back (granted or not).
        await ApkUpdater.requestUpdatePermissions({
          ...(optionsRef.current?.permissionPromptOptions ?? {}),
          showNativeDialog: true,
          ...(override?.permissions
            ? { permissions: override.permissions }
            : {}),
        });
      } catch (err) {
        console.warn("[ApkUpdater] Native permission prompt failed:", err);
      }
    }
    const fresh = await readPermissionStatus();
    if (permissionGatePassed(fresh)) {
      // `resumeUpdateFlow` (appStateChange) may already have continued the
      // parked update when the user came back from Settings; the shared
      // helper is guarded, so whichever runs first continues it exactly once
      // and any grant path without backgrounding is covered here.
      await onRequiredPermissionsGranted();
      return true;
    }
    // Not granted (declined, or came back from Settings without enabling
    // it): the APK update stays blocked - it cannot install without the
    // permission - while the parked update is kept persisted AND awaited so
    // the next grant (this session or the next launch) resumes it. The
    // bundle/OTA flow is released so the app keeps working WITHOUT these
    // permissions.
    onRequiredPermissionsMissing();
    return false;
  };

  const handleApkUpdate = async (
    info: ApkUpdateInfo | null = apkUpdateInfo,
  ) => {
    if (!info) return;
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
      return;
    if (updateActiveRef.current) return;
    // Claim the attempt SYNCHRONOUSLY - before the async permission gate - so
    // a second call (double tap, racing appStateChange resume vs. a resolving
    // permission prompt) can never start a second download/install.
    updateActiveRef.current = true;

    // Mirror the AppUpdate (bundle) flow: close the popup SYNCHRONOUSLY and
    // enter the "downloading" phase in the same tick, so the very first paint
    // is the progress screen. A force update must never flash the popup; a
    // manual press jumps straight to progress too.
    setApkUpdateModalVisible(false);
    setApkError(null);
    emitProgress({
      phase: "downloading",
      downloadPercent: 0,
      stagingPercent: -1,
      bytesWritten: 0,
      totalBytes: 0,
      message: undefined,
    });

    // Permission gate: never start a download while the app cannot install it
    // yet - the update flow is BLOCKED without the install permission. The
    // NATIVE per-permission popups run instead; once granted the update starts
    // automatically (force) or the popup re-appears (optional).
    try {
      const status = await readPermissionStatus();
      if (status && !permissionGatePassed(status)) {
        updateInfoRef.current = info;
        setApkUpdateInfo(info);
        // We are waiting on permissions, not downloading - the shared
        // bookkeeping resets it to idle when the flow parks (and a granted
        // grant-continuation restarts this update from there).
        emitProgress({
          phase: "permission",
          downloadPercent: 0,
          stagingPercent: -1,
          bytesWritten: 0,
          totalBytes: 0,
          message: undefined,
        });
        // Nothing is downloading yet - release the claim so the blocked
        // bookkeeping can release the OTA priority and a later grant can
        // restart this same update.
        updateActiveRef.current = false;
        await ensureApkPermissions();
        return;
      }
    } catch {
      /* permission check unavailable - try the update anyway */
    }

    updateInfoRef.current = info;
    // Priority: a FORCED APK update takes the gate over the bundle/OTA flow
    // from the moment it actually starts (it may have been released to
    // "clear" while waiting for the permission - see
    // releasePriorityWithoutPermissions).
    if (info.forceUpdate) {
      setApkUpdatePriority("blocked");
    }
    reportedRef.current = { success: false, failure: false };
    // updateActiveRef was already claimed synchronously above.
    try {
      localStorage.setItem(
        APK_UPDATE_IN_PROGRESS_KEY,
        JSON.stringify({
          versionCode: info.availableVersionCode,
          versionName: info.availableVersionName,
          apkId: info.apkId,
        }),
      );
    } catch {
      // ignore
    }
    clearPendingInfo();
    pendingInfoRef.current = null;
    await runUpdate(info);
  };

  /**
   * Runs when the app returns to the foreground after the Settings round trip:
   * re-checks the permissions. When granted, closes the parked permission wait
   * and continues - the update popup for optional updates, straight into the
   * progress screen for force updates (or resumes a parked attempt); when not
   * granted, stays parked until the next launch re-prompts and releases the
   * bundle/OTA gate so the app keeps working without the permissions.
   */
  const resumeUpdateFlow = async () => {
    if (!awaitingPermissionRef.current) return;
    const status = await readPermissionStatus();
    if (!status) return;
    if (!permissionGatePassed(status)) {
      // Still missing a permission: keep the APK update parked, but never
      // block the bundle/OTA flow on it.
      releasePriorityWithoutPermissions();
      return;
    }
    // Another grant path (a resolving native prompt or an explicit JS
    // request/check) may already have continued the parked update while this
    // status read was in flight - only ONE of them may run.
    if (!awaitingPermissionRef.current) return;
    setApkBlockedByPermission(false);
    const info = pendingInfoRef.current ?? updateInfoRef.current;
    awaitingPermissionRef.current = false;
    pendingInfoRef.current = null;
    clearPendingInfo();
    optionsRef.current?.onPermissionsGranted?.();
    optionsRef.current?.onInstallPermissionGranted?.();
    // Leave the "permission" wait state (the continuations below emit their
    // own phase - downloading for force, none needed for the popup).
    if (
      !updateActiveRef.current &&
      progressRef.current.phase === "permission"
    ) {
      emitProgress({ phase: "idle", stagingPercent: -1 });
    }
    const attemptInProgress = !!localStorage.getItem(
      APK_UPDATE_IN_PROGRESS_KEY,
    );
    if (info && attemptInProgress) {
      updateActiveRef.current = false;
      await handleApkUpdate(info);
    } else if (updateInfoRef.current) {
      if (updateInfoRef.current.forceUpdate) {
        // Force update: re-offer means restart, never the popup.
        await handleApkUpdate(updateInfoRef.current);
      } else {
        setApkUpdateModalVisible(true);
      }
    }
  };

  useEffect(() => {
    let listeners: PluginListenerHandle[] = [];
    let cancelled = false;

    (async () => {
      // Track install state always, so the UI and flags can recover from
      // failures/cancelled installs and staging progress can be reported.
      try {
        const installListener = await ApkUpdater.addListener(
          "installState",
          (state) => {
            setInstallState(state);
            optionsRef.current?.onInstallStateChange?.(state);

            if (state.state === "staging") {
              if (
                progressRef.current.phase === "installing" &&
                typeof state.percent === "number"
              ) {
                emitProgress({
                  stagingPercent: Math.min(100, Math.max(0, state.percent)),
                });
              }
              return;
            }
            if (state.state === "pending_user_action") {
              emitProgress({ phase: "confirming" });
              return;
            }
            if (state.state === "success") {
              fireSuccess(consumeStoredAttempt(null));
              setApkUpdatePriority("clear");
              return;
            }
            if (state.state === "failure") {
              failUpdate(
                updateInfoRef.current,
                state.message ?? "APK install failed.",
                "state",
              );
            }
          },
        );
        listeners.push(installListener);
      } catch (err) {
        console.warn("[ApkUpdater] Failed to listen installState:", err);
      }

      // Download progress - always delivered (drives your own progress UI).
      try {
        const downloadListener = await ApkUpdater.addListener(
          "downloadProgress",
          (event) => {
            if (progressRef.current.phase !== "downloading") return;
            emitProgress({
              downloadPercent: Math.min(100, Math.max(0, event.percent)),
              bytesWritten: event.bytesWritten,
              totalBytes: event.totalBytes,
            });
          },
        );
        listeners.push(downloadListener);
      } catch (err) {
        console.warn("[ApkUpdater] Failed to listen downloadProgress:", err);
      }

      // Returning from the Settings permission round trip: continue the
      // update automatically once the permission is granted.
      try {
        const appStateListener = await App.addListener(
          "appStateChange",
          async ({ isActive }) => {
            if (!isActive) return;
            try {
              await resumeUpdateFlow();
            } catch {
              // ignore - the user can still tap "Update" manually
            }
          },
        );
        listeners.push(appStateListener);
      } catch (err) {
        console.warn("[ApkUpdater] Failed to listen appStateChange:", err);
      }

      try {
        const appInfo = await ApkUpdater.getAppInfo();
        if (cancelled) return;

        // Permission-first: check BOTH toggles on app open. The update popup
        // only appears once both are granted (install required, overlay for
        // auto-reopen). First launch therefore shows the permission prompt -
        // never the update popup straight after install.
        const gate = await readPermissionStatus();
        if (cancelled) return;

        // Keep asking for whatever the device is still missing on EVERY open
        // - including when the gate ALREADY passes on "Install unknown apps"
        // alone ("Display over other apps" is best-effort). That was exactly
        // where the popup used to stop re-appearing: after a relaunch the
        // required permission was in, so nothing triggered the missing
        // overlay popup anymore. Fire-and-forget so this best-effort prompt
        // can never delay the update flow; with nativePermissionPrompt
        // disabled it only re-checks (no dialog is drawn).
        if (gate && permissionGatePassed(gate)) {
          const requested: ApkPermissionKind[] =
            optionsRef.current?.permissionPromptOptions?.permissions ?? [
              "install",
              "overlay",
            ];
          const stillMissing =
            (requested.includes("install") && !gate.canInstall) ||
            (requested.includes("overlay") && !gate.canDrawOverlays);
          if (stillMissing) {
            ensureApkPermissions().catch(() => {
              // Best-effort prompt - never affects the update flow.
            });
          }
        }

        // 1) A previous attempt may have completed while this process was
        //    killed by the install - verify and surface the success exactly
        //    like the bundle flow does after a reload.
        if (!updateActiveRef.current) {
          const stored = consumeStoredAttempt(Number(appInfo.versionCode));
          if (stored) fireSuccess(stored);
        }

        // 2) Resume an interrupted permission wait, if any (survives process
        //    death while the user was on the App info page).
        if (!updateActiveRef.current && !successFiredRef.current) {
          const pendingInfo = readPendingInfo();
          if (pendingInfo) {
            updateInfoRef.current = pendingInfo;
            setApkUpdateInfo(pendingInfo);
            setApkUpdatePriority(pendingInfo.forceUpdate ? "blocked" : "clear");
            const current = gate ?? (await readPermissionStatus());
            if (permissionGatePassed(current)) {
              clearPendingInfo();
              awaitingPermissionRef.current = false;
              pendingInfoRef.current = null;
              setApkBlockedByPermission(false);
              if (pendingInfo.forceUpdate) {
                // Force update: never show the popup - go straight to progress.
                await handleApkUpdate(pendingInfo);
              } else {
                setApkUpdateModalVisible(true);
              }
              return;
            }
            // Still waiting: run the NATIVE per-permission popups (each opens
            // its own Settings page); the update popup only appears once the
            // required permission is granted.
            awaitingPermissionRef.current = true;
            pendingInfoRef.current = pendingInfo;
            emitProgress({ phase: "permission" });
            const granted = await ensureApkPermissions();
            if (granted) {
              clearPendingInfo();
              if (pendingInfo.forceUpdate) {
                // Force update: start it directly (no-op if ensure already did).
                await handleApkUpdate(pendingInfo);
              } else {
                setApkUpdateModalVisible(true);
              }
            } else {
              // Cannot install without the permission: keep the APK update
              // blocked, but release the bundle/OTA gate so the AppUpdate flow
              // keeps working.
              releasePriorityWithoutPermissions();
            }
            return;
          }
        }

        // 3) Ask the update server for the latest APK.
        const response = await CapacitorHttp.get({
          url: `${normalizeApkBaseUrl(optionsRef.current?.baseUrl)}/projects/get-apk`,
          headers: getHeaders(optionsRef.current?.apiKey),
          params: {
            key: optionsRef.current?.projectKey ?? "",
            packageName: optionsRef.current?.packageName || appInfo.packageName,
          },
        });
        if (cancelled) return;

        const data = response.data ?? {};
        const availableVersionCode = Number(data.versionCode ?? 0);
        const url = data.url as string | undefined;

        if (!url || !availableVersionCode) {
          setApkUpdatePriority("clear");
          return;
        }
        if (availableVersionCode <= appInfo.versionCode) {
          setApkUpdatePriority("clear");
          // Already up to date - drop any stale attempt marker.
          if (!updateActiveRef.current) {
            try {
              localStorage.removeItem(APK_UPDATE_IN_PROGRESS_KEY);
            } catch {
              // ignore
            }
          }
          return;
        }

        const info: ApkUpdateInfo = {
          availableVersionCode,
          availableVersionName: data.versionName ?? "",
          url,
          forceUpdate: data.forceUpdate ?? false,
          apkId: data.apkId ?? "",
          buildType: data.buildType,
          isDebugApk: data.isDebugApk,
        };

        // Client-side guard (server + CLI already enforce this): a release
        // install must never consume a debug APK - the signatures cannot
        // match, so the install would fail (or worse, sideload a debug build
        // over production). Block it here instead of downloading.
        if (
          optionsRef.current?.rejectDebugApkOnRelease !== false &&
          isDebugApkUpdate(info) &&
          appInfo.debuggable === false
        ) {
          setApkUpdatePriority("clear");
          const reason =
            "Blocked: server offered a debug APK to a release install - refusing to download/install.";
          console.warn(`[ApkUpdater] ${reason}`, info);
          try {
            optionsRef.current?.onBlockedUpdate?.(info, reason);
          } catch {
            // ignore callback errors
          }
          return;
        }

        if (cancelled || updateActiveRef.current) return;
        updateInfoRef.current = info;
        setApkUpdateInfo(info);
        setApkUpdatePriority(info.forceUpdate ? "blocked" : "clear");
        // Permission gate: the APK update only starts when the permissions it
        // requires are granted; otherwise the NATIVE per-permission popups run
        // (each opening its own Settings page) and the update stays parked.
        const status = gate ?? (await readPermissionStatus());
        if (!permissionGatePassed(status)) {
          pendingInfoRef.current = info;
          persistPendingInfo(info);
          awaitingPermissionRef.current = true;
          setApkUpdateModalVisible(false);
          await ensureApkPermissions();
          return;
        }
        if (info.forceUpdate) {
          // Force update: the popup must NEVER flash - don't even set it
          // visible; handleApkUpdate enters the "downloading" phase in this
          // same tick, so the first paint is already the progress screen
          // (same behaviour as the AppUpdate/ bundle flow).
          await handleApkUpdate(info);
        } else {
          setApkUpdateModalVisible(true);
        }
      } catch (err) {
        setApkUpdatePriority("clear");
        console.warn("[ApkUpdater] Failed to fetch update:", err);
      }
    })();

    return () => {
      cancelled = true;
      listeners.forEach((listener) => {
        try {
          listener.remove();
        } catch {
          // ignore
        }
      });
    };
  }, [options?.apiKey, options?.projectKey, options?.packageName]);

  const restartApp = async () => {
    await ApkUpdater.restartApp();
  };

  /**
   * Checks ONE special permission ("install" or "overlay") without any dialog
   * or Settings trip. Use it in your own JS permission popup. Returns true when
   * the permission is granted (or not needed on this Android version).
   *
   * When the check reveals the WHOLE gate is granted it also runs the shared
   * granted bookkeeping (clears `apkBlockedByPermission`, fires the grant
   * callbacks and continues a parked update), so a custom popup that re-checks
   * after the Settings round trip behaves exactly like the native prompt.
   */
  const checkApkPermission = async (
    kind: ApkPermissionKind,
  ): Promise<boolean> => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
      return true;
    try {
      const result =
        kind === "overlay"
          ? await ApkUpdater.checkOverlayPermission()
          : await ApkUpdater.checkInstallPermission();
      const status = await readPermissionStatus();
      // A check must never BLOCK anything, but when it reveals the whole gate
      // is granted it runs the same bookkeeping as every other grant path:
      // clear the blocked flag, notify the grant callbacks and continue a
      // parked update (idempotent - a racing resume/prompt already did it).
      if (status && permissionGatePassed(status)) {
        await onRequiredPermissionsGranted();
      }
      return result.granted || result.required === false;
    } catch {
      const status = await readPermissionStatus();
      return kind === "overlay"
        ? !!status?.canDrawOverlays
        : !!status?.canInstall;
    }
  };

  /**
   * Requests ONE special permission with its OWN native popup (whose Continue
   * opens that permission's Settings page - the user never has to find the
   * toggle). Pass `showNativeDialog: false` to skip the popup and only resolve
   * the current state, so your own JS UI can drive the flow. Resolves true when
   * the permission is granted afterwards.
   *
   * When the grant completes the WHOLE gate, the shared granted bookkeeping
   * runs (clears `apkBlockedByPermission`, fires the grant callbacks and
   * continues a parked update); when a required permission is still missing
   * the APK update stays blocked while the bundle/OTA priority is released.
   */
  const requestApkPermission = async (
    kind: ApkPermissionKind,
    promptOptions?: ApkPermissionPromptOptions,
  ): Promise<boolean> => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
      return true;
    try {
      const status = normalizePermissionStatus(
        kind === "overlay"
          ? await ApkUpdater.requestOverlayPermission(promptOptions)
          : await ApkUpdater.requestInstallPermission(promptOptions),
      );
      const agreed =
        kind === "overlay" ? status.canDrawOverlays : status.canInstall;
      setApkPermissionStatus(status);
      setCanInstall(status.canInstall);
      optionsRef.current?.onPermissionStatusChange?.(status);
      if (permissionGatePassed(status)) {
        // The whole gate is granted now: same bookkeeping as the combined
        // native prompt - unblock, notify the grant callbacks and continue a
        // parked update (force -> straight into progress, optional -> popup).
        await onRequiredPermissionsGranted();
      } else {
        // Still missing a REQUIRED permission: the APK update stays blocked
        // (it cannot install) while the bundle/OTA flow is released - the app
        // keeps working without these permissions. Covers every kind, so a
        // `requiredPermissions: "both"` gate can never stay stuck either.
        onRequiredPermissionsMissing();
      }
      return agreed;
    } catch {
      return false;
    }
  };

  /**
   * Opens the Settings page of ONE permission directly (no dialog): "install"
   * -> "Install unknown apps" (`ACTION_MANAGE_UNKNOWN_APP_SOURCES`), "overlay"
   * -> "Display over other apps" (`ACTION_MANAGE_OVERLAY_PERMISSION`). Use it
   * from your own JS permission popup - and it remembers a known update so the
   * flow continues automatically once the user is back with the grant.
   */
  const openApkPermissionSettings = async (
    kind: ApkPermissionKind = "install",
  ) => {
    awaitingPermissionRef.current = true;
    const info = updateInfoRef.current;
    if (info) {
      pendingInfoRef.current = info;
      persistPendingInfo(info);
      emitProgress({ phase: "permission" });
    }
    if (kind === "overlay") {
      await ApkUpdater.openOverlayPermissionSettings();
    } else {
      await ApkUpdater.openInstallPermissionSettings();
    }
  };

  /**
   * Opens the "install unknown apps" Settings page directly. Kept for
   * compatibility - prefer `openApkPermissionSettings("install")` (or let the
   * NATIVE popup do everything via `ensureApkPermissions()`).
   */
  const openInstallPermissionSettings = () =>
    openApkPermissionSettings("install");

  /** Opens the "Display over other apps" Settings page directly. */
  const openOverlayPermissionSettings = () =>
    openApkPermissionSettings("overlay");

  /**
   * Whether the "Update installed - tap to open" fallback notification can be
   * shown right now (always true on Android 12 and below). Call it when your
   * update screen mounts; if it returns false, call
   * `requestNotificationPermission()` - that shows the standard in-app system
   * dialog on Android 13+ (no Settings trip), so the fallback is ready before
   * the install kills the process.
   */
  const canShowUpdateNotification = async (): Promise<boolean> => {
    if (
      !Capacitor.isNativePlatform() ||
      Capacitor.getPlatform() !== "android"
    ) {
      return false;
    }
    try {
      const result = await ApkUpdater.canNotify();
      return result.canNotify;
    } catch {
      return true; // native check unavailable - try to post anyway
    }
  };

  /**
   * Asks for the notification permission with the standard in-app dialog on
   * Android 13+ (resolves immediately on Android 12 and below). Best called
   * from a user gesture (e.g. your "Update now" button) right before
   * `handleApkUpdate()`.
   */
  const requestNotificationPermission = async (): Promise<boolean> => {
    if (
      !Capacitor.isNativePlatform() ||
      Capacitor.getPlatform() !== "android"
    ) {
      return false;
    }
    try {
      const result = await ApkUpdater.requestNotificationPermission();
      return result.granted;
    } catch {
      return false;
    }
  };

  return {
    apkUpdateInfo,
    /** Gate OTA updates until APK checking/forced APK installation is done. */
    apkUpdatePriority,
    isApkUpdateModalVisible,
    setApkUpdateModalVisible,
    handleApkUpdate,
    /** Overall 0-100 progress across download + install (drive your UI). */
    apkProgress,
    /** Rich progress payload: phase, overall percent, raw download bytes. */
    apkProgressInfo,
    /** Current phase - drive your own progress UI from this. */
    apkPhase,
    /** True while the update is running (permission/download/install/confirm). */
    isApkUpdating: UPDATING_PHASES.includes(apkPhase),
    /** Last failure/cancel message, null when there is none. */
    apkError,
    /** True on the launch right after a successful update (for your toast). */
    apkUpdateJustCompleted,
    installState,
    canInstall,
    restartApp,
    openInstallPermissionSettings,
    /** Opens the "Display over other apps" Settings page directly. */
    openOverlayPermissionSettings,
    /** Opens ONE permission's Settings page: `openApkPermissionSettings(kind)`. */
    openApkPermissionSettings,
    /**
     * Checks ONE permission without any dialog/Settings trip.
     * `checkApkPermission("install" | "overlay")`.
     */
    checkApkPermission,
    /**
     * Requests ONE permission with its OWN native popup (Continue opens that
     * permission's Settings page). `showNativeDialog: false` skips the popup
     * and only resolves the state, for your own JS UI.
     */
    requestApkPermission,
    canShowUpdateNotification,
    requestNotificationPermission,
    /**
     * Permission state `{ canInstall, canDrawOverlays, ready, canUpdate }`.
     * `canUpdate` (install permission granted) is what gating uses by default;
     * `ready` stays "both granted" for reference.
     */
    apkPermissionStatus,
    /**
     * True while the APK update is blocked because its permissions are not
     * granted (declined, or Settings trip without enabling). The APK flow is
     * blocked - the bundle/OTA flow never is. Use it to show a "grant
     * permissions" affordance.
     */
    apkBlockedByPermission,
    /**
     * Checks the permissions and, when something is missing, runs the NATIVE
     * popup flow (one Java dialog per missing permission, host app theme +
     * app logo, each Continue opening that permission's own Settings page).
     * Returns true when the update may proceed. Call on app open (before any
     * update UI). With `{ showNativeDialog: false }` (or the
     * `nativePermissionPrompt: false` hook option) it only checks.
     */
    ensureApkPermissions,
    /** Re-reads both permissions without prompting. */
    refreshApkPermissionStatus: readPermissionStatus,
  };
}
