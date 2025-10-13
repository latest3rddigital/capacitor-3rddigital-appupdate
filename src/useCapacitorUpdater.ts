import { App } from "@capacitor/app";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import { message } from "antd";
import { useEffect, useState } from "react";
import type { UpdateInfo } from "./types.js";

const API_BASE_URL = "https://dev.3rddigital.com/appupdate-api/api";

export function useCapacitorUpdater(options?: {
  iosPackage?: string;
  androidPackage?: string;
  apiKey?: string;
}) {
  const [isUpdateModalVisible, setUpdateModalVisible] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    (async () => {
      if (!Capacitor.isNativePlatform()) return;

      try {
        await CapacitorUpdater.notifyAppReady();

        const response = await CapacitorHttp.get({
          url: `${API_BASE_URL}/projects/get-bundle`,
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
        message.error("Failed to check for updates.");
      }
    })();
  }, [options?.apiKey, options?.iosPackage, options?.androidPackage]);

  const handleUpdate = async (info = updateInfo) => {
    if (!info) return;
    setUpdateModalVisible(false);

    const hideLoader = message.loading("Downloading update...", 0);

    try {
      const data = await CapacitorUpdater.download({
        version: info.availableVersion.toString(),
        url: info.url,
      });

      await CapacitorUpdater.set(data);

      await CapacitorHttp.post({
        url: `${API_BASE_URL}/bundles/${info.bundleId}/count`,
        headers: { "Content-Type": "application/json" },
        data: { status: "success" },
      });

      hideLoader();
      message.success("Update installed successfully!");
      console.log("[CapacitorUpdater] Update installed");
    } catch (err: any) {
      const deviceinfo = await Device.getInfo();
      await CapacitorHttp.post({
        url: `${API_BASE_URL}/bundles/${info.bundleId}/count`,
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

      hideLoader();
      message.error("Failed to install update.");
      console.error("[CapacitorUpdater] Failed to install update:", err);
    }
  };

  return {
    updateInfo,
    isUpdateModalVisible,
    setUpdateModalVisible,
    handleUpdate,
  };
}
