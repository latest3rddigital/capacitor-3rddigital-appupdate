import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { useEffect, useRef, useState } from "react";
import { ApkUpdater } from "./apkPlugin.js";
import type {
  ApkInstallStateInfo,
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
 * Flow:
 * 1. Reads the installed app info, asks the server for the latest APK.
 * 2. If the server versionCode is higher, shows the update modal (or
 *    auto-starts on `forceUpdate`).
 * 3. `handleApkUpdate()` downloads the APK (progress events), then commits
 *    the PackageInstaller session.
 * 4. The "install unknown apps" permission is NOT pre-checked by default: the
 *    system installer shows its own inline prompt and resumes the install by
 *    itself once the user grants it - no round trip back to this app, no
 *    reopening the app to see the popup. (Optional preflight via
 *    `preflightInstallPermission`; the flow auto-resumes on return either way.)
 * 5. After the install the OS kills the process; on relaunch the stored target
 *    versionCode is compared with the installed one and `onUpdateSuccess` /
 *    `apkUpdateJustCompleted` fire exactly once, so the app can show its
 *    "App updated successfully" message - same as the bundle/AppUpdate flow.
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
  /** @deprecated Progress events are always delivered now; kept for compatibility. */
  showProgress?: boolean;
  /** Called with the overall 0-100 progress while downloading/installing. */
  onProgress?: (percent: number, info: ApkProgressInfo) => void;
  /** Called whenever the update phase changes. */
  onPhaseChange?: (phase: ApkUpdatePhase, info: ApkProgressInfo) => void;
  onInstallStateChange?: (state: ApkInstallStateInfo) => void;
  /** Called when the user comes back from Settings with the permission granted. */
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
   * Off by default. When enabled, the flow asks for the "install unknown
   * apps" permission BEFORE downloading by opening Settings once; on return
   * the update continues automatically (no reopen / second tap needed).
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
  // True while parked on the "install unknown apps" Settings screen.
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

  const handleApkUpdate = async (
    info: ApkUpdateInfo | null = apkUpdateInfo,
  ) => {
    if (!info) return;
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
      return;
    // Already running (the auto-resume continued it) - avoid a second download.
    if (updateActiveRef.current) return;

    setApkUpdateModalVisible(false);
    setApkError(null);
    updateInfoRef.current = info;
    // New attempt: allow one success + one failure report again.
    reportedRef.current = { success: false, failure: false };
    updateActiveRef.current = true;
    // Persist the target so a completed update can be detected on relaunch
    // (the OS kills this process during the install).
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

    // Optional: ask for the permission BEFORE downloading. Off by default -
    // without it the system installer shows its own inline permission prompt
    // and resumes the install right after the user grants it, so the user
    // never bounces back to this screen for the popup.
    if (optionsRef.current?.preflightInstallPermission) {
      try {
        const permission = await ApkUpdater.canInstall();
        setCanInstall(permission.canInstall);
        if (!permission.canInstall) {
          awaitingPermissionRef.current = true;
          pendingInfoRef.current = info;
          persistPendingInfo(info);
          emitProgress({ phase: "permission" });
          await ApkUpdater.openInstallPermissionSettings();
          // Parked on Settings: `resumeUpdateFlow` continues automatically
          // as soon as the permission is granted.
          return;
        }
      } catch {
        // Permission check unavailable - the installer handles it inline.
      }
    }

    await runUpdate(info);
  };

  /**
   * Runs when the app returns to the foreground. If we were parked on the
   * "install unknown apps" Settings screen: continue the update automatically
   * when the permission was granted (no reopen / second tap needed), or stop
   * waiting and re-offer the update when it was not.
   */
  const resumeUpdateFlow = async () => {
    if (!awaitingPermissionRef.current) return;

    let granted = false;
    try {
      const permission = await ApkUpdater.canInstall();
      setCanInstall(permission.canInstall);
      granted = permission.canInstall;
    } catch {
      return; // cannot tell yet - stay parked
    }

    const info = pendingInfoRef.current ?? updateInfoRef.current;
    awaitingPermissionRef.current = false;
    pendingInfoRef.current = null;
    clearPendingInfo();

    if (!granted) {
      if (updateActiveRef.current) {
        failUpdate(info, "Install permission was not granted.", "task");
      }
      return;
    }

    optionsRef.current?.onInstallPermissionGranted?.();
    const attemptInProgress = !!localStorage.getItem(
      APK_UPDATE_IN_PROGRESS_KEY,
    );
    if (info && attemptInProgress) {
      // Permission granted while an attempt was parked: continue silently.
      updateActiveRef.current = false;
      await handleApkUpdate(info);
    } else if (updateInfoRef.current) {
      // No attempt started yet (permission requested up front): re-offer the
      // update so the user stays in control of the download.
      setApkUpdateModalVisible(true);
    }
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
      return;

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

        try {
          setCanInstall((await ApkUpdater.canInstall()).canInstall);
        } catch {
          setCanInstall(null);
        }

        // 1) A previous attempt may have completed while this process was
        //    killed by the install - verify and surface the success exactly
        //    like the bundle flow does after a reload.
        if (!updateActiveRef.current) {
          const stored = consumeStoredAttempt(Number(appInfo.versionCode));
          if (stored) fireSuccess(stored);
        }

        // 2) Resume an interrupted "install unknown apps" wait, if any
        //    (survives process death while the user was in Settings).
        if (!updateActiveRef.current && !successFiredRef.current) {
          const pendingInfo = readPendingInfo();
          if (pendingInfo) {
            updateInfoRef.current = pendingInfo;
            setApkUpdateInfo(pendingInfo);
            let granted = false;
            try {
              granted = (await ApkUpdater.canInstall()).canInstall;
              setCanInstall(granted);
            } catch {
              granted = false;
            }
            if (granted) {
              clearPendingInfo();
              awaitingPermissionRef.current = false;
              pendingInfoRef.current = null;
              await handleApkUpdate(pendingInfo);
              return;
            }
            // Still waiting: continue exactly where we left off (Settings);
            // `resumeUpdateFlow` takes over when the user comes back.
            awaitingPermissionRef.current = true;
            pendingInfoRef.current = pendingInfo;
            emitProgress({ phase: "permission" });
            await ApkUpdater.openInstallPermissionSettings();
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
        setApkUpdateModalVisible(true);

        if (info.forceUpdate) await handleApkUpdate(info);
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
   * Opens the "install unknown apps" Settings page. When an update is known,
   * the hook remembers it and continues automatically (or re-offers the
   * modal) as soon as the user comes back with the permission granted.
   *
   * NOTE: only needed when `preflightInstallPermission: true` is used. In the
   * default flow the system installer shows its own inline
   * "Allow from this source" prompt and resumes the install itself, so the
   * user never leaves the app for Settings.
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
  };
}
