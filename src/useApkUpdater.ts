import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { useEffect, useRef, useState } from "react";
import { ApkUpdater } from "./apkPlugin.js";
import type {
  ApkInstallStateInfo,
  ApkPermissionStatus,
  ApkProgressInfo,
  ApkUpdateInfo,
  ApkUpdatePhase,
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
 * Permission-first flow (all Android versions):
 * 1. On app open, call `ensureApkPermissions()` (or read
 *    `apkPermissionStatus`). It checks BOTH "Install unknown apps"
 *    (REQUIRED to install any APK) and "Display over other apps"
 *    (best-effort helper so the app can reopen itself after the OS kills it
 *    for the install). Neither can be granted programmatically, so the
 *    plugin shows its NATIVE permission dialog - ONE Android dialog built
 *    from the host app's theme and logo (it looks like a system permission
 *    popup, so no per-project UI is needed) that lists BOTH permissions
 *    together; Continue opens the app's **App info page** where both toggles
 *    live, so the user enables everything in one place and returns once.
 *    The update popup (`isApkUpdateModalVisible`) only appears once the
 *    permission gate passes, so the user never sees "update available"
 *    before the app is actually able to install it.
 * 3. `handleApkUpdate()` downloads the APK (progress events), then commits
 *    the PackageInstaller session. After the install the OS kills the
 *    process; on relaunch the stored target versionCode is compared with the
 *    installed one and `onUpdateSuccess` / `apkUpdateJustCompleted` fire
 *    exactly once ("App updated successfully" - same as bundle flow).
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
  /** Called when the user comes back with both permissions granted. */
  onPermissionsGranted?: () => void;
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
   * now ALWAYS pre-checks both permissions on app open (install-unknown-apps
   * REQUIRED, overlay best-effort) using the plugin's NATIVE dialog and only
   * shows the update popup once ready.
   * @deprecated Always behaves as `true`; kept so existing code compiles.
   */
  preflightInstallPermission?: boolean;
}) {
  const [apkUpdateInfo, setApkUpdateInfo] = useState<ApkUpdateInfo | null>(
    null,
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
  // True while parked on the native permission prompt (App info round trip).
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

  const readPermissionStatus = async (): Promise<ApkPermissionStatus | null> => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
      return null;
    try {
      const status = await ApkUpdater.getPermissionStatus();
      const ready = status.canInstall && status.canDrawOverlays;
      const full: ApkPermissionStatus = { ...status, ready };
      setApkPermissionStatus(full);
      setCanInstall(status.canInstall);
      return full;
    } catch {
      try {
        const legacy = await ApkUpdater.canInstall();
        const full: ApkPermissionStatus = {
          canInstall: legacy.canInstall,
          canDrawOverlays: true,
          ready: legacy.canInstall,
        };
        setApkPermissionStatus(full);
        setCanInstall(legacy.canInstall);
        return full;
      } catch {
        return null;
      }
    }
  };

  /**
   * Permission-first gate. Call it on app open (before showing any update
   * UI): checks BOTH "Install unknown apps" (required) and "Display over
   * other apps" (auto-reopen helper). When something is missing it runs the
   * plugin's NATIVE permission flow - ONE Android dialog (host app theme +
   * the app's own logo, so it looks like a system permission popup in every
   * project and needs no custom UI here) listing BOTH permissions together;
   * Continue opens the app's App info page where both toggles live, so the
   * user enables everything in one place and returns once. Returns true
   * only when the update popup may be shown.
   */
  const ensureApkPermissions = async (): Promise<boolean> => {
    const status = await readPermissionStatus();
    if (!status) return true;
    if (status.ready) return true;
    awaitingPermissionRef.current = true;
    const info = updateInfoRef.current;
    if (info) {
      pendingInfoRef.current = info;
      persistPendingInfo(info);
    }
    emitProgress({ phase: "permission" });
    try {
      // Native dialog flow: ONE combined prompt, then the App info page
      // (both toggles); resolves when the user is back (granted or not).
      await ApkUpdater.requestUpdatePermissions();
    } catch (err) {
      console.warn("[ApkUpdater] Native permission prompt failed:", err);
    }
    const fresh = await readPermissionStatus();
    if (fresh?.ready) {
      // `resumeUpdateFlow` (appStateChange) normally continued the parked
      // update the moment the user came back from Settings; this fallback
      // covers grant paths where no backgrounding happened.
      if (awaitingPermissionRef.current) {
        awaitingPermissionRef.current = false;
        optionsRef.current?.onPermissionsGranted?.();
        optionsRef.current?.onInstallPermissionGranted?.();
        const parked = pendingInfoRef.current;
        pendingInfoRef.current = null;
        clearPendingInfo();
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
      }
      if (
        !updateActiveRef.current &&
        progressRef.current.phase === "permission"
      ) {
        emitProgress({ phase: "idle", stagingPercent: -1 });
      }
      return true;
    }
    // Declined for now: keep a parked update persisted so the next launch
    // resumes it as soon as the permissions are granted.
    awaitingPermissionRef.current = false;
    if (!updateActiveRef.current && progressRef.current.phase === "permission") {
      emitProgress({ phase: "idle", stagingPercent: -1 });
    }
    return false;
  };

  const handleApkUpdate = async (
    info: ApkUpdateInfo | null = apkUpdateInfo,
  ) => {
    if (!info) return;
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
      return;
    if (updateActiveRef.current) return;

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

    // Permission-first: never start a download while the app cannot install
    // it yet. The NATIVE permission dialog runs instead; once granted the
    // update starts automatically (force) or the popup re-appears (optional).
    try {
      const status = await readPermissionStatus();
      if (status && !status.ready) {
        updateInfoRef.current = info;
        setApkUpdateInfo(info);
        await ensureApkPermissions();
        return;
      }
    } catch { /* permission check unavailable - try the update anyway */ }

    updateInfoRef.current = info;
    reportedRef.current = { success: false, failure: false };
    updateActiveRef.current = true;
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
   * Runs when the app returns to the foreground after the App info round
   * trip: re-checks BOTH toggles. When granted, closes the parked
   * permission wait and continues - the update popup for optional updates,
   * straight into the progress screen for force updates (or resumes a parked
   * attempt); when not granted, stays parked until the next launch re-prompts.
   */
  const resumeUpdateFlow = async () => {
    if (!awaitingPermissionRef.current) return;
    const status = await readPermissionStatus();
    if (!status) return;
    if (!status.ready) return; // still missing a toggle - stay parked
    const info = pendingInfoRef.current ?? updateInfoRef.current;
    awaitingPermissionRef.current = false;
    pendingInfoRef.current = null;
    clearPendingInfo();
    optionsRef.current?.onPermissionsGranted?.();
    optionsRef.current?.onInstallPermissionGranted?.();
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
            const current = gate ?? (await readPermissionStatus());
            if (current && current.ready) {
              clearPendingInfo();
              awaitingPermissionRef.current = false;
              pendingInfoRef.current = null;
              if (pendingInfo.forceUpdate) {
                // Force update: never show the popup - go straight to progress.
                await handleApkUpdate(pendingInfo);
              } else {
                setApkUpdateModalVisible(true);
              }
              return;
            }
            // Still waiting: run the NATIVE permission flow (one shared
            // system-style dialog covering both permissions); the update
            // popup only appears once both toggles are granted.
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

        if (!url || !availableVersionCode) return;
        if (availableVersionCode <= appInfo.versionCode) {
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
        // Permission-first: only show the update popup when both toggles are
        // granted; otherwise run the NATIVE permission flow (the shared
        // system-style dialog) and keep the update parked until granted.
        const ready =
          gate?.ready ?? (await readPermissionStatus())?.ready ?? true;
        if (!ready) {
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
   * Opens the "install unknown apps" Settings page directly. When an update
   * is known, the hook remembers it and continues automatically as soon as
   * the user comes back with the permissions granted. Normally you do not
   * need this - `ensureApkPermissions()` runs the shared NATIVE permission
   * dialog for every missing permission by itself.
   */
  const openInstallPermissionSettings = async () => {
    awaitingPermissionRef.current = true;
    const info = updateInfoRef.current;
    if (info) {
      pendingInfoRef.current = info;
      persistPendingInfo(info);
      emitProgress({ phase: "permission" });
    }
    await ApkUpdater.openInstallPermissionSettings();
  };

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
    canShowUpdateNotification,
    requestNotificationPermission,
    /**
     * Combined permission state `{ canInstall, canDrawOverlays, ready }`.
     * `ready` is true only when BOTH toggles are granted - gate the APK
     * update popup on it.
     */
    apkPermissionStatus,
    /**
     * Checks both toggles and, when something is missing, runs the NATIVE
     * permission dialog flow (host app theme + app logo - no per-project UI).
     * Returns true when the update popup may be shown. Call on app open
     * (before any update UI).
     */
    ensureApkPermissions,
    /** Re-reads both toggles without prompting. */
    refreshApkPermissionStatus: readPermissionStatus,
  };
}
