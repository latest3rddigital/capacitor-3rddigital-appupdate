import React from "react";
import type { ApkUpdaterModalProps } from "./apkTypes.js";

/**
 * Modal for prompting the user to install an APK update (Android only flow).
 * Mirrors `UpdaterModal` but works with `ApkUpdateInfo` and can render a
 * download progress bar. Fully separate from the bundle update modal.
 */
export const ApkUpdaterModal: React.FC<ApkUpdaterModalProps> = ({
  visible,
  updateInfo,
  onConfirm,
  onCancel,
  customUI,
  title = "New Version Available",
  message,
  confirmText = "Update",
  cancelText = "Later",
  showProgress = false,
  progress = 0,
  styles = {},
}) => {
  if (!visible || !updateInfo) return null;

  if (customUI) return customUI(updateInfo, onConfirm, onCancel);

  const {
    overlay = {},
    container = {},
    title: titleStyle = {},
    message: messageStyle = {},
    progressBar = {},
    progressFill = {},
    buttonRow = {},
    confirmButton = {},
    cancelButton = {},
  } = styles;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        ...overlay,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 20,
          width: 320,
          textAlign: "center",
          ...container,
        }}
      >
        <h3 style={{ margin: "0 0 10px", ...titleStyle }}>{title}</h3>
        <p style={{ marginBottom: 20, ...messageStyle }}>
          {message ||
            `A new version (${updateInfo.availableVersionName || updateInfo.availableVersionCode}) is available.`}
        </p>

        {showProgress && progress > 0 && (
          <div
            style={{
              height: 6,
              width: "100%",
              background: "#e0e0e0",
              borderRadius: 3,
              overflow: "hidden",
              marginBottom: 16,
              ...progressBar,
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, progress))}%`,
                background: "#007bff",
                borderRadius: 3,
                transition: "width 0.2s ease",
                ...progressFill,
              }}
            />
          </div>
        )}

        <div
          style={{
            marginTop: 16,
            display: "flex",
            gap: 10,
            justifyContent: "center",
            ...buttonRow,
          }}
        >
          <button
            onClick={onConfirm}
            style={{
              background: "#007bff",
              color: "#fff",
              border: "none",
              padding: "8px 16px",
              borderRadius: 4,
              cursor: "pointer",
              ...confirmButton,
            }}
          >
            {confirmText}
          </button>

          <button
            onClick={onCancel}
            style={{
              background: "#ccc",
              border: "none",
              padding: "8px 16px",
              borderRadius: 4,
              cursor: "pointer",
              ...cancelButton,
            }}
          >
            {cancelText}
          </button>
        </div>
      </div>
    </div>
  );
};
