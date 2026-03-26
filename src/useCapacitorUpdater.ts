import { App } from "@capacitor/app";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import { useEffect, useState } from "react";
import type { UpdateInfo } from "./types.js";

export function useCapacitorUpdater(options?: {
  baseUrl: string;
  iosPackage?: string;
  androidPackage?: string;
  apiKey?: string;
  showProgress?: boolean;
  onProgress?: (percent: number) => void;
}) {
  const APPUPDATE_BASE_URL = options?.baseUrl;
  const [isUpdateModalVisible, setUpdateModalVisible] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let downloadListener: any;

    (async () => {
      try {
        await CapacitorUpdater.notifyAppReady();

        const response = await CapacitorHttp.get({
          url: `${APPUPDATE_BASE_URL}/projects/get-bundle`,
          params: {
            key: options?.apiKey ?? "",
            iosPackage: options?.iosPackage ?? "",
            androidPackage: options?.androidPackage ?? "",
          },
        });

        const platformData =
          Capacitor.getPlatform() === "android"
            ? response.data.android
            : response.data.ios;

        const {
          version: availableVersion = 0,
          url,
          forceUpdate = false,
          bundleId,
          appVersion,
        } = platformData;

        const currentBundle = await CapacitorUpdater.current();
        const currentVersion =
          currentBundle.bundle.version === "builtin"
            ? 0
            : Number(currentBundle.bundle.version);

        const currentAppVersion = (await App.getInfo()).version;
        const currentBundleVersion = appVersion ?? currentAppVersion;

        if (
          availableVersion > currentVersion &&
          currentAppVersion === currentBundleVersion
        ) {
          const info: UpdateInfo = {
            availableVersion,
            url,
            forceUpdate,
            bundleId,
          };
          setUpdateInfo(info);
          setUpdateModalVisible(true);

          if (forceUpdate) await handleUpdate(info);
        }
      } catch (err) {
        console.warn("[CapacitorUpdater] Failed to fetch update:", err);
      }
    })();

    if (options?.showProgress) {
      downloadListener = CapacitorUpdater.addListener("download", (event) => {
        const percent = Math.min(100, Math.max(0, event.percent));
        setProgress(percent);
        if (options?.onProgress) options.onProgress(percent);
      });
    }

    return () => {
      if (downloadListener) downloadListener.remove();
    };
  }, [options?.apiKey, options?.iosPackage, options?.androidPackage]);

  const handleUpdate = async (info = updateInfo) => {
    if (!info) return;
    setUpdateModalVisible(false);

    try {
      const data = await CapacitorUpdater.download({
        version: info.availableVersion.toString(),
        url: info.url,
      });

      if (!data?.id) {
        throw new Error("Bundle download failed or invalid ID");
      }

      await CapacitorUpdater.next({ id: data?.id });

      await CapacitorHttp.post({
        url: `${APPUPDATE_BASE_URL}/bundles/${info.bundleId}/count`,
        headers: { "Content-Type": "application/json" },
        data: { status: "success" },
      });

      localStorage.setItem("UPDATE_IN_PROGRESS", "true");

      setTimeout(async () => {
        console.log("[CapacitorUpdater] Update installed");
        await CapacitorUpdater.reload();
      }, 2500);
    } catch (err: any) {
      const deviceinfo = await Device.getInfo();
      await CapacitorHttp.post({
        url: `${APPUPDATE_BASE_URL}/bundles/${info.bundleId}/count`,
        headers: { "Content-Type": "application/json" },
        data: {
          status: "failure",
          error: err?.message ?? "Failed to install update.",
          deviceInfo: {
            model: deviceinfo.model,
            brand: deviceinfo.manufacturer,
            systemName: deviceinfo.operatingSystem,
            systemVersion: deviceinfo.osVersion,
          },
        },
      });

      console.error("[CapacitorUpdater] Failed to install update:", err);
    }
  };

  return {
    updateInfo,
    isUpdateModalVisible,
    setUpdateModalVisible,
    handleUpdate,
    progress,
  };
}
