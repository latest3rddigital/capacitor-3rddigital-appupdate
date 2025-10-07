export interface UpdateInfo {
  availableVersion: number;
  url: string;
  forceUpdate: boolean;
  bundleId: string;
}

export interface UpdaterModalProps {
  visible: boolean;
  updateInfo: UpdateInfo | null;
  onConfirm: () => void;
  onCancel: () => void;
  customUI?: (
    info: UpdateInfo,
    onConfirm: () => void,
    onCancel: () => void
  ) => React.ReactNode;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  styles?: {
    overlay?: React.CSSProperties;
    container?: React.CSSProperties;
    title?: React.CSSProperties;
    message?: React.CSSProperties;
    buttonRow?: React.CSSProperties;
    confirmButton?: React.CSSProperties;
    cancelButton?: React.CSSProperties;
  };
}
