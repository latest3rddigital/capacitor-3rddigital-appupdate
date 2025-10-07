import React from "react";
import type { UpdaterModalProps } from "./types.js";

export const UpdaterModal: React.FC<UpdaterModalProps> = ({
  visible,
  updateInfo,
  onConfirm,
  onCancel,
  customUI,
  title = "Update Available",
  message,
  confirmText = "Update",
  cancelText = "Cancel",
  styles = {},
}) => {
  if (!visible || !updateInfo) return null;

  if (customUI) return customUI(updateInfo, onConfirm, onCancel);

  const {
    overlay = {},
    container = {},
    title: titleStyle = {},
    message: messageStyle = {},
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
            `A new version (${updateInfo.availableVersion}) is available.`}
        </p>

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
