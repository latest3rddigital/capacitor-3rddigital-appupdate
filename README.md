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
npm install @capacitor/app @capacitor/core @capacitor/device @capgo/capacitor-updater
```

After installation, build your app and sync Capacitor:

```sh
npm run build
npx cap sync
```

## 📦 Usage in Your App

- Use the useCapacitorUpdater hook to check for updates and handle modal UI:

```sh
import React from "react";
import { UpdaterModal, useCapacitorUpdater } from "capacitor-3rddigital-appupdate";

const App = () => {
  const { isUpdateModalVisible, updateInfo, handleUpdate, setUpdateModalVisible } = useCapacitorUpdater({
    baseUrl: 'https://your-api-url.com',
    projectKey: 'YOUR_PROJECT_KEY',
    apiKey: 'YOUR_API_KEY',
    iosPackage: "com.example.ios",
    androidPackage: "com.example.android",
    showProgress: true,
    onProgress: (p) => console.log(`Progress: ${p}%`),
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

🔹 useCapacitorUpdater(options?: { baseUrl: string; iosPackage?: string; androidPackage?: string; projectKey: string; apiKey: string; showProgress?: boolean; onProgress?: (percent: number) => void })

- Checks the server for available updates and manages the modal prompt.

Options:

| Key              | Type     | Required | Description                                             |
| ---------------- | -------- | -------- | ------------------------------------------------------- |
| `baseUrl`        | string   | ✅       | Base url for app update                                 |
| `projectKey`     | string   | ✅       | Project key to identify the app on your update server   |
| `apiKey`         | string   | ✅       | API key sent in the `Api-Key` header for authentication |
| `iosPackage`     | string   | ❌       | iOS bundle/package identifier                           |
| `androidPackage` | string   | ❌       | Android bundle/package identifier                       |
| `showProgress`   | boolean  | ❌       | Show real-time download percentage                      |
| `onProgress`     | function | ❌       | Callback invoked with download progress percentage      |

Returns:

| Key                     | Type             | Description                         |
| ----------------------- | ---------------- | ----------------------------------- |
| `updateInfo`            | `UpdateInfo`     | Metadata about the available update |
| `isUpdateModalVisible`  | `boolean`        | Whether the update modal is visible |
| `setUpdateModalVisible` | `(bool) => void` | Show/hide modal manually            |
| `handleUpdate`          | `() => void`     | Downloads and installs the update   |
| `progress`              | `number`         | Download progress                   |

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

### Environment Variables

The CLI reads the following environment variables from your `.env` file:

| Variable                          | Description                                                    |
| --------------------------------- | -------------------------------------------------------------- |
| `APPUPDATE_BASE_URL`              | Base URL of your update server                                 |
| `APPUPDATE_API_KEY`               | API key used for authentication (sent in the `Api-Key` header) |
| `APPUPDATE_AWS_REGION`            | AWS region for S3 uploads                                      |
| `APPUPDATE_AWS_ACCESS_KEY_ID`     | AWS access key ID for S3 uploads                               |
| `APPUPDATE_AWS_SECRET_ACCESS_KEY` | AWS secret access key for S3 uploads                           |
| `APPUPDATE_AWS_BUCKET_NAME`       | AWS S3 bucket name for bundle storage                          |

### Build & Upload

```sh
npx appupdate android
npx appupdate ios
npx appupdate all
```

You will be prompted for:

- API Token
- Project ID
- Environment (development / production)
- Android flavor, when `productFlavors` are present
- iOS target, when multiple app targets are present
- Version
- Bundle zip file, when multiple generated bundles are available
- Force Update (true/false)

What it does

- Builds your React web app
- Creates Capgo zip bundle
- Uploads bundle + metadata to your update server
