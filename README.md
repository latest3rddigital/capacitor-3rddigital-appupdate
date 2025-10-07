# capacitor-3rddigital-appupdate

A Capacitor + React library for **seamless Over-The-Air (OTA) updates** with:

- 🔄 Automatic version checks
- 📥 Bundle download & installation (iOS & Android)
- ⚡ Configurable user prompts (dialogs)
- 🛠️ CLI tool for building & uploading bundles to your update server

## 🚀 Installation

```sh
npm install capacitor-3rddigital-appupdate
# or
yarn add capacitor-3rddigital-appupdate
```

This package has peer dependencies that also need to be installed:

```sh
npm install @capacitor/core @capacitor/device @capgo/capacitor-updater
```

Run pod install for iOS:

```sh
cd ios && pod install
```

## 📦 Usage in Your App

- Use the useCapacitorUpdater hook to check for updates and handle modal UI:

```sh
import React from "react";
import { UpdaterModal, useCapacitorUpdater } from "capacitor-3rddigital-appupdate";

const App = () => {
  const { isUpdateModalVisible, updateInfo, handleUpdate, setUpdateModalVisible } = useCapacitorUpdater({
    iosPackage: "com.example.ios",
    androidPackage: "com.example.android",
    key: "example-key",
  });

  return (
    <div>
      {/* Your app content */}
      {isUpdateModalVisible && updateInfo && (
        <UpdaterModal
          visible={isUpdateModalVisible}
          updateInfo={updateInfo}
          onConfirm={() => handleUpdate()}
          onCancel={() => setUpdateModalVisible(false)}
        />
      )}
    </div>
  );
};

export default App;
```

## ⚙️ API Reference

🔹 useCapacitorUpdater(options?: { iosPackage?: string; androidPackage?: string })

- Checks the server for available updates and manages the modal prompt.

Returns:

| Key                     | Type             | Description                         |
| ----------------------- | ---------------- | ----------------------------------- |
| `updateInfo`            | `UpdateInfo`     | Metadata about the available update |
| `isUpdateModalVisible`  | `boolean`        | Whether the update modal is visible |
| `setUpdateModalVisible` | `(bool) => void` | Show/hide modal manually            |
| `handleUpdate`          | `() => void`     | Downloads and installs the update   |

🔹 UpdaterModal

- Global modal component for prompting users to update.

Props:

| Key           | Type       | Default              | Description                         |
| ------------- | ---------- | -------------------- | ----------------------------------- |
| `visible`     | boolean    | ❌                   | Show/hide modal                     |
| `updateInfo`  | UpdateInfo | ❌                   | Update metadata                     |
| `onConfirm`   | function   | ❌                   | Callback when user confirms update  |
| `onCancel`    | function   | ❌                   | Callback when user cancels update   |
| `customUI`    | function   | ❌                   | Custom render for the modal UI      |
| `title`       | string     | `"Update Available"` | Modal title                         |
| `message`     | string     | `undefined`          | Modal message                       |
| `confirmText` | string     | `"Update"`           | Confirm button text                 |
| `cancelText`  | string     | `"Cancel"`           | Cancel button text                  |
| `styles`      | object     | `{}`                 | Style overrides for modal & buttons |

## 🖥️ CLI Tool – appupdate

- This package provides a CLI for building & uploading OTA bundles.

Build & Upload

```sh
npx appupdate android
npx appupdate ios
npx appupdate all
```

You will be prompted for:

- API Token
- Project ID
- Environment (development / production)
- Version
- Build Number
- Force Update (true/false)

What it does

- Builds your React web app
- Creates Capgo zip bundle
- Uploads bundle + metadata to your update server (https://dev.3rddigital.com/appupdate-api/api/)
