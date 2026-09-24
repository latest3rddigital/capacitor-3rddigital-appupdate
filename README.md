# capacitor-3rddigital-appupdate

A Capacitor + React library for **seamless Over-The-Air (OTA) updates** with:

- 🔄 Automatic version checks
- 📥 Bundle download & installation (iOS & Android)
- 📱 Android in-app **APK updates** (download from S3 → install → restart) via a bundled native plugin
- ⚡ Configurable user prompts (dialogs)
- 🛠️ CLI tool for building & uploading bundles and APKs to your update server

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

> ℹ️ **APK update support (Android)**: this package ships with a native Android
> plugin (`ApkUpdater`). `npx cap sync` wires it into your Android project
> automatically — no extra installation steps. The required permissions
> (`REQUEST_INSTALL_PACKAGES`, `UPDATE_PACKAGES_WITHOUT_USER_ACTION`,
> `SYSTEM_ALERT_WINDOW`, `POST_NOTIFICATIONS`, `INTERNET`)
> and a FileProvider are merged
> into your app's manifest automatically by the Android manifest merger.

## 📦 Usage in Your App

### 1. OTA Bundle Updates (iOS & Android)

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

### 2. In-App APK Updates (Android only)

A fully separate flow from the bundle flow. The app compares the **versionCode**
published on your update server against the installed one; if a newer APK
exists it is downloaded from S3, reported to the server, and installed through
the system `PackageInstaller`.

The hook is **UI-free** — it only exposes states/props/callbacks, so _your_
project renders the update prompt and the download/install progress screen
(the same pattern you use for the AppUpdate flow). The package's own
`ApkUpdaterModal` remains available but is completely optional.

How it behaves:

- **Permission-first (all Android versions):** on app open the hook checks
  BOTH "Install unknown apps" (REQUIRED to install any APK) and "Display over
  other apps" (lets the app reopen itself after the OS kills it for the
  install). Neither can be granted programmatically, so the plugin shows its
  **native permission dialog** — ONE Android `AlertDialog` drawn with the host
  app's own **theme and logo** (it looks like a system permission popup, so
  **no per-project UI/styling is ever needed**) that lists **both permission
  messages in a single popup**. Continue opens the app's **App info page** —
  where both toggles live (Android 8+ lists "Install unknown apps", Android
  6+ lists "Display over other apps") — so the user enables **both in one
  place and returns once**; the flow then re-checks both toggles. The APK
  update popup only appears once both are granted — first launch therefore
  shows the native permission dialog, never the update popup straight after
  install.
- On **Android 12+** (with the `UPDATE_PACKAGES_WITHOUT_USER_ACTION` permission) the
  self-update is **silent**: the app is killed and restarted automatically when
  the install completes.
- **Force update (`forceUpdate: true`)**: the update popup is **never shown** —
  the flow jumps straight to your progress UI (`isApkUpdating` flips to `true`
  in the same tick the update starts, so the first paint is already the
  progress screen). Only optional updates show the confirmation popup. On a
  failure the popup re-appears as the retry affordance.
- Otherwise the **system installer dialog** opens (the plugin auto-launches it).
- **Notifications ("Update installed — tap to open" fallback)**: on Android
  13+ this needs the `POST_NOTIFICATIONS` runtime permission — but that is a
  **standard in-app system dialog** (`Allow` / `Don't allow`), not a Settings
  page. Ask for it from your "Update now" button before calling
  `handleApkUpdate()`:
  `await requestNotificationPermission()` (check first with
  `await canShowUpdateNotification()`). On Android 12 and below it is
  auto-granted. Without it the fallback notification is silently skipped —
  the automatic reopen paths still run.
- **"Display over other apps"**: NOT required for the install itself — only a
  best-effort helper so the app can reopen itself from the background after
  the OS kills it for the install. It is listed in the SAME single native
  dialog (together with "Install unknown apps") and enabled from the same
  App info page. Without it the update
  still works via the tap-to-open notification fallback.
- **Progress**: `isApkUpdating` + `apkPhase` + `apkProgress`/`apkProgressInfo`
  track the whole journey (download → install-session staging → waiting for
  confirmation → done). Feed them into your own progress screen.
- **After the install**: the OS kills the process; the plugin tries to reopen
  the app automatically (instant direct start below Android 10, otherwise a
  `setAlarmClock()` + background-start opt-in chain ~1s later). On Android
  10+ the OS may still block every automatic path — in that case an
  "Update installed — tap to open" notification is posted so one tap always
  brings the updated app back. On that relaunch `onUpdateSuccess` /
  `apkUpdateJustCompleted` fire once so you can show your success message —
  exactly like the AppUpdate flow. If the device is locked, the app opens
  behind the lock screen (Android never bypasses the PIN/pattern/fingerprint).

```tsx
import { useEffect, useState } from "react";
import { useApkUpdater } from "capacitor-3rddigital-appupdate";
import { message } from "antd"; // or your own toast
import YourUpdateModal from "./YourUpdateModal"; // your project's prompt UI
import YourProgressScreen from "./YourProgressScreen"; // your project's progress UI

const App = () => {
  const [progress, setProgress] = useState(0);

  const {
    apkUpdateInfo,
    isApkUpdateModalVisible,
    setApkUpdateModalVisible,
    handleApkUpdate,
    apkPhase,
    apkProgress,
    apkProgressInfo,
    isApkUpdating,
    apkError,
    apkUpdateJustCompleted,
    apkPermissionStatus,
    ensureApkPermissions,
  } = useApkUpdater({
    baseUrl: "https://your-api-url.com",
    projectKey: "YOUR_PROJECT_KEY",
    apiKey: "YOUR_API_KEY",
    // optional: defaults to the installed applicationId read from the device
    packageName: "com.example.android",
    // overall 0-100 across download + install (also available as state)
    onProgress: (percent, info) => setProgress(percent),
    onPhaseChange: (phase) => console.log("APK update phase:", phase),
    // fired once on the launch AFTER the update installed (process was killed)
    onUpdateSuccess: () => message.success("App updated successfully"),
  });

  // Permission-first: ask on app open, BEFORE any update popup. This runs the
  // plugin's NATIVE dialog (app logo + system style) listing BOTH permissions
  // in one popup; Continue opens App info where both are enabled in one place.
  useEffect(() => {
    ensureApkPermissions();
  }, []);

  return (
    <div>
      {/* Your app content */}
      {/* Update prompt - only after apkPermissionStatus.ready */}
      {isApkUpdateModalVisible && apkUpdateInfo && (
        <YourUpdateModal
          updateInfo={apkUpdateInfo}
          onConfirm={() => handleApkUpdate()}
          onCancel={() => setApkUpdateModalVisible(false)}
        />
      )}

      {/* Your own download/install progress screen */}
      {isApkUpdating && (
        <YourProgressScreen progress={apkProgress} phase={apkPhase} />
      )}
    </div>
  );
};

export default App;
```

> 💡 You can render both modals at once. When an APK update is available it
> usually supersedes bundle updates (the APK already contains the new web
> bundle), so a common pattern is to show the APK modal first and only fall
> back to the bundle modal while no APK update is pending.

## ⚙️ API Reference

### 🔹 useCapacitorUpdater(options?: { baseUrl: string; iosPackage?: string; androidPackage?: string; projectKey: string; apiKey: string; showProgress?: boolean; onProgress?: (percent: number) => void })

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

### 🔹 useApkUpdater(options?: { baseUrl: string; projectKey?: string; packageName?: string; apiKey?: string; onProgress?; onPhaseChange?; onInstallStateChange?; onInstallPermissionGranted?; onUpdateSuccess?; preflightInstallPermission?: boolean })

- Android-only hook that checks the server for the latest APK, matches the
  installed `versionCode`, downloads the APK from S3, and installs it via the
  system PackageInstaller. **UI-free**: it only exposes states/props/callbacks —
  your project renders its own update prompt and progress screen (same pattern
  as `useCapacitorUpdater`). Does nothing on iOS/web.

Options:

| Key                          | Type                                                     | Required | Description                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                    | string                                                   | ✅       | Base url for app update                                                                                                                                                       |
| `projectKey`                 | string                                                   | ✅       | Project key to identify the app on your update server                                                                                                                         |
| `apiKey`                     | string                                                   | ✅       | API key sent in the `Api-Key` header for authentication                                                                                                                       |
| `packageName`                | string                                                   | ❌       | Android applicationId. Defaults to the installed app's package                                                                                                                |
| `rejectDebugApkOnRelease`    | boolean                                                  | ❌       | Default `true`: a release install ignores debug-flagged updates (needs `buildType`/`isDebugApk` from the server)                                                              |
| `onBlockedUpdate`            | `(info: ApkUpdateInfo, reason: string) => void`          | ❌       | Fired when a debug update is blocked on a release install                                                                                                                     |
| `showProgress`               | boolean                                                  | ❌       | Deprecated — progress events are always delivered now                                                                                                                         |
| `onProgress`                 | `(percent: number, info: ApkProgressInfo) => void`       | ❌       | Overall 0-100 progress across download + install                                                                                                                              |
| `onPhaseChange`              | `(phase: ApkUpdatePhase, info: ApkProgressInfo) => void` | ❌       | Fired when the phase changes                                                                                                                                                  |
| `onInstallStateChange`       | function                                                 | ❌       | Callback with `{ state: "staging" \| "pending_user_action" \| "success" \| "failure", message?, percent? }`                                                                   |
| `onPermissionsGranted`        | `() => void`                                             | ❌       | Both toggles granted after the permission Settings round trip (update popup re-appears)                                            |
| `onInstallPermissionGranted`  | `() => void`                                             | ❌       | Deprecated alias of `onPermissionsGranted` (kept for compatibility)                                                                                                         |
| `onUpdateSuccess`            | `(info: { versionCode, versionName? }) => void`          | ❌       | Fired once on the launch after a successful update — show your success message here (like the AppUpdate flow)                                                                 |
| `preflightInstallPermission`  | boolean                                                  | ❌       | Deprecated — the flow ALWAYS checks both permissions on app open (native dialog) and only shows the update popup once ready       |

Returns:

| Key                             | Type                          | Description                                                                                |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `apkUpdateInfo`                 | `ApkUpdateInfo \| null`       | Metadata about the available APK update                                                    |
| `isApkUpdateModalVisible`       | `boolean`                     | Whether the update prompt state is visible                                                 |
| `setApkUpdateModalVisible`      | `(bool) => void`              | Show/hide your update prompt                                                               |
| `handleApkUpdate`               | `() => Promise<void>`         | Starts download → install (idempotent while running)                                       |
| `apkProgress`                   | `number`                      | Overall 0-100: download 0–90, install staging 90–99, awaiting confirmation 99, success 100 |
| `apkProgressInfo`               | `ApkProgressInfo`             | `{ phase, percent, downloadPercent, bytesWritten, totalBytes, message }`                   |
| `apkPhase`                      | `ApkUpdatePhase`              | `idle \| permission \| downloading \| installing \| confirming \| success \| failure`      |
| `isApkUpdating`                 | `boolean`                     | `true` while the update runs — show your progress screen                                   |
| `apkError`                      | `string \| null`              | Last failure/cancel message (prompt re-opens automatically for retry)                      |
| `apkUpdateJustCompleted`        | `boolean`                     | `true` on the launch right after a successful update                                       |
| `installState`                  | `ApkInstallStateInfo \| null` | Latest install state reported by the native plugin                                         |
| `canInstall`                    | `boolean \| null`             | Whether the "install unknown apps" permission is granted (from the combined gate)                                              |
| `apkPermissionStatus`           | `{ canInstall, canDrawOverlays, ready } \| null` | Combined gate — `ready` only when BOTH toggles granted; show the update popup only then |
| `ensureApkPermissions`          | `() => Promise<boolean>`      | Call on app open — checks both toggles and runs the plugin's NATIVE permission dialog when not ready (no web UI to style)       |
| `refreshApkPermissionStatus`    | `() => Promise<status>`       | Re-reads both toggles without prompting                                                                                        |
| `restartApp`                    | `() => Promise<void>`         | Relaunches the app and kills the current process                                                                             |
| `openInstallPermissionSettings` | `() => Promise<void>`         | Manual fallback: opens the "install unknown apps" Settings page directly (normally unnecessary — `ensureApkPermissions` covers it) |

### 🔹 ApkUpdaterModal

- `ApkUpdaterModal` — prompt for installing an APK update (separate from
  `UpdaterModal`). Render it only after `apkPermissionStatus.ready`.
- The permission prompt itself is NOT a web modal: it is the plugin's native
  Android dialog (host app theme + app logo), so there is nothing to render
  or restyle per project.

Props:

| Key            | Type          | Default                   | Description                                       |
| -------------- | ------------- | ------------------------- | ------------------------------------------------- |
| `visible`      | boolean       | ❌                        | Show/hide modal                                   |
| `updateInfo`   | ApkUpdateInfo | ❌                        | APK update metadata                               |
| `onConfirm`    | function      | ❌                        | Callback when user confirms update                |
| `onCancel`     | function      | ❌                        | Callback when user cancels update                 |
| `customUI`     | function      | ❌                        | Custom render for the modal UI                    |
| `title`        | string        | `"New Version Available"` | Modal title                                       |
| `message`      | string        | `undefined`               | Modal message                                     |
| `confirmText`  | string        | `"Update"`                | Confirm button text                               |
| `cancelText`   | string        | `"Later"`                 | Cancel button text                                |
| `showProgress` | boolean       | `false`                   | Show the download progress bar                    |
| `progress`     | number        | `0`                       | Download progress percentage                      |
| `styles`       | object        | `{}`                      | Style overrides for modal, progress bar & buttons |

### 🔹 ApkUpdater (native plugin, Android only)

Also exported directly for advanced/manual usage. Methods:

| Method                                          | Returns                                     | Description                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `getAppInfo()`                                  | `{ packageName, versionName, versionCode }` | Installed app info (versionCode from PackageInfo)                                                                                        |
| `getPermissionStatus()`                         | `{ canInstall, canDrawOverlays, ready }`   | Combined gate for the pre-update prompt (neither toggle can be granted programmatically)                                                  |
| `requestUpdatePermissions(options?)`           | `{ canInstall, canDrawOverlays, ready }`   | NATIVE permission prompt — ONE Android dialog (host app theme + the app's logo) listing BOTH permissions together; Continue opens the app's **App info page** where both toggles live (Android 8+ "Install unknown apps", Android 6+ "Display over other apps"), so the user allows both in ONE place and returns once; optional copy overrides: `title`, `message`, `confirmText`, `cancelText` |
| `canInstall()`                                  | `{ canInstall: boolean }`                   | Whether the app may install APKs (Android never grants this silently — the user enables it in Settings)                                  |
| `openInstallPermissionSettings()`               | `void`                                      | Opens the "install unknown apps" settings                                                                                                |
| `download({ url, versionName?, versionCode? })` | `{ path, size }`                            | Downloads the APK from S3, emits `downloadProgress` events                                              |
| `install({ filePath? })`                        | `{ status, message? }`                      | Commits the PackageInstaller session (handles the inline permission prompt itself; intent fallback)     |
| `restartApp()`                                  | `void`                                      | Relaunches the app and kills the current process                                                        |

Events:

| Event              | Payload                                                                                       | Description                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `downloadProgress` | `{ percent, bytesWritten, totalBytes, versionName }`                                          | Fired while the APK downloads                                                                                                                                                                                                                           |
| `installState`     | `{ state: "staging" \| "pending_user_action" \| "success" \| "failure", message?, percent? }` | Install status. `staging` includes a real 0–100 `percent` while the APK is copied into the install session. On `success` the native side silently relaunches the app (direct start below Android 10, system-sent PendingIntent above — no notification) |

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

### Build & Upload (APK) – `appupdate-apk`

A dedicated CLI for the Android in-app APK update flow. It is **fully separate
from the bundle script** (`appupdate`), so the bundle/iOS flow is never
affected. It builds a signed release APK (web build → cap sync → gradle) and
uploads + registers it:

```sh
npx appupdate-apk                        # uses `npm run build`
npx appupdate-apk dev                    # uses `npm run build:dev`
npx appupdate-apk live                   # uses `npm run build:live`
npx appupdate-apk prod                   # uses `npm run build:prod`
npx appupdate-apk dev:test               # uses `npm run build:dev:test`
npx appupdate-apk dev.test               # uses `npm run build:dev.test`
npx appupdate-apk local-tablet           # uses `npm run build:local-tablet`
npx appupdate-apk upload                 # skip building: pick ANY existing APK (release + debug)
npx appupdate-apk upload dev             # upload-only, records environment `dev`
npx appupdate-apk --apk <path>           # upload this exact APK (skips scan)
npx appupdate-apk --flavor <name>        # build / look for this Android product flavor
npx appupdate-apk --env <name>           # web-build suffix override (same as `dev`)
npx appupdate-apk --project <id> --api-token <t> [--force|--no-force] [--yes]
npx appupdate-apk --help                 # full usage
```

> The `<suffix>` argument is passed straight to npm as `npm run build:<suffix>`,
> so **any** environment script your app defines works, including scripts whose
> names contain a colon or a dash (`dev`, `live`, `prod`, `dev2`, `dev:test`,
> `dev.test`, `local-tablet`, …). Only the first colon is treated as a separator
> in the bundle CLI (`appupdate all:dev:test`), so both CLIs accept the same
> names. Without a suffix it runs `npm run build`.

> **Java is picked for you.** Capacitor 7's `capacitor-android` module compiles
> with `sourceCompatibility 21`, so Gradle needs a **JDK 21+**. `appupdate-apk`
> resolves one automatically (macOS `/usr/libexec/java_home`, Android Studio's
> bundled JBR, Homebrew/`/usr/lib/jvm` locations) even when your shell's
> `JAVA_HOME` points at an older JDK – which otherwise fails with the confusing
> `:capacitor-android:compileReleaseJavaWithJavac FAILED → error: invalid source
release: 21`. Override it with `APPUPDATE_JAVA_HOME=/path/to/jdk-21` if needed.

What it does, step by step:

1. Prompts for API Token, Project ID, Environment (development / production)
   (`--project`, `--api-token` skip the prompts; `APPUPDATE_API_TOKEN` /
   `APPUPDATE_PROJECT_ID` are used when present). The environment defaults from
   the suffix – `live`/`prod`/`production` → production, everything else →
   development. `--yes` accepts that default and every other detected value
   **without any prompt** (fully non-interactive builds).
2. **Android variant / flavor selection** – same UX as the bundle upload,
   pre-filling package name, version name and **version code per flavor**
   (`--flavor <name>` skips the picker; works for multi-target projects)
3. **Versions are auto-detected** (gradle `defaultConfig` / flavor /
   `package.json`) and only **confirmed** – `Continue with version X (code Y)?`.
   Press Enter to keep the detected values or pass `--yes` to accept all.
4. Builds the web app (`npm run build[:env]` – the script is validated first,
   with a clear error when e.g. `build:live` does not exist) and syncs it
   (`npx cap sync android` – this is what wires the `ApkUpdater` native plugin
   into the Android project). All commands run inside the app root even when
   invoked via npx from `node_modules/.bin`.
5. **Resolves the signing config dynamically** (see below) and runs
   `./gradlew assemble<Flavor>Release` with AGP's
   `-Pandroid.injected.signing.*` properties (gradlew is chmod +x'd when
   needed; `gradlew.bat` is used on Windows). The Gradle JVM is chosen
   automatically so the build always gets a **JDK 21+** (see above), no matter
   what `JAVA_HOME` the calling shell has.
6. Locates the APK to upload: a **project-wide scan** (every `*.apk` under
   the app root — `android/app/build/outputs/apk/**` AND manually moved
   folders such as `android/app/<flavor>/release/`, `android/app/release/`,
   `release/` — skipping `node_modules`, `.git`, `intermediates`, `tmp`,
   `generated`; plus `$APPUPDATE_APK_DIR` which may point outside the
   project). When Gradle is UP-TO-DATE and touches nothing, the newest
   existing outputs for the same variant are used instead of reporting
   "no APK" — so an already-built release APK is always visible/selectable.
   Release output is **always preferred over debug** (debug + unsigned rank
   last, and a warning is printed when only debug APKs exist), and unsigned
   (`*-unsigned.apk`) outputs are never auto-picked – if only an unsigned APK
   was produced, the signing config is reported instead of silently
   uploading something Android cannot install.
7. **Verifies the APK** by reading the `output-metadata.json` AGP writes next to
   it (applicationId / versionName / versionCode that are _actually inside_ the
   APK) and asks for confirmation if they differ from what you typed
8. **Debug-APK guard**: debug APKs are blocked for `production` unless you
   repeat with `--allow-debug-apk`; the registered payload carries
   `buildType`/`isDebugApk` so the backend + the app can enforce
   release-never-gets-debug too.
9. Uploads it to S3 under `uploads/<environment>/apk/` and registers it via
   `POST {baseUrl}/apks` (same payload as described in the API contract).
   The URL is joined safely (`APPUPDATE_BASE_URL` with a trailing `/` no
   longer produces `//apks` → 404 "route not found").

In `upload` mode steps 4-5 are skipped: **every** existing APK in the project
is listed – release **and** debug, all flavors, wherever it was built or
moved to – labelled `[release]` / `[DEBUG]` / `[UNSIGNED]` with sizes (or pass
`--apk <path>` / `APPUPDATE_APK_DIR=<dir>` to skip the scan), then steps 7-9
run. Upload mode does not ask
for a flavor (the APK itself carries the package/version); pass
`--flavor <name>` if you want the list filtered to one flavor directory.

#### ⚠️ versionCode / versionName must be bumped in `android/app/build.gradle`

AGP has **no** way to override the version from the command line (the historical
`android.injected.version.*` properties do not exist), so the version inside the
APK always comes from `android/app/build.gradle`. Because the app compares the
server's `versionCode` with the APK's own `versionCode`, a mismatch would make
the app prompt for an update forever.

The script therefore reads the real values from the built APK and registers
those (warning you when they differ from what you entered):

```groovy
// android/app/build.gradle
defaultConfig {
    versionCode 22      // <-- bump before releasing
    versionName "2.2.0"
}
```

#### Keystore resolution (dynamic – nothing hardcoded)

Signing is injected via AGP's built-in `-Pandroid.injected.signing.*`
properties, so **no changes to your gradle files are required**. The injected
config also **takes precedence over the project's own
`signingConfig signingConfigs.debug`** in the release build type. The script
resolves the keystore in this order:

1. **Environment variables** (recommended for CI):
   | Variable | Description |
   | --------------------------------- | ---------------------------------- |
   | `APPUPDATE_KEYSTORE_PATH` | Path to the `.jks` / `.keystore` |
   | `APPUPDATE_KEYSTORE_PASSWORD` | Keystore (store) password |
   | `APPUPDATE_KEYSTORE_ALIAS` | Key alias |
   | `APPUPDATE_KEY_PASSWORD` | Key password (falls back to store) |
   | `APPUPDATE_KEYSTORE_PROPERTIES_FILE` | Custom properties file location |
2. **`android/keystore.properties`** (or `APPUPDATE_KEYSTORE_PROPERTIES_FILE`)
   supporting common key names: `storeFile`/`KEYSTORE_FILE`,
   `storePassword`/`KEYSTORE_PASSWORD`, `keyAlias`/`KEY_ALIAS`,
   `keyPassword`/`KEY_PASSWORD`
3. **Auto-scan**: any `*.jks` / `*.keystore` file inside the `android/`
   directory – if found, it prompts for the passwords (interactive only)

If no complete keystore configuration can be resolved, the script warns loudly
and the build falls back to your project's default signing config (usually the
**debug keystore**). An APK signed with a different key than the installed app
**cannot** be installed over it, so always release real in-app updates with your
production keystore.

### Upload a pre-built APK (no build)

If you already have an APK (e.g. built by CI) and only want to upload/register
it, use the same CLI in `upload` mode – the bundle CLI (`appupdate`) is not
touched by the APK flow at all:

```sh
npx appupdate-apk upload              # lists every existing APK (release + debug)
npx appupdate-apk upload dev          # same, but records environment `dev`
npx appupdate-apk --apk android/app/build/outputs/apk/release/app-release.apk
```

It lists **all** APKs under `android/app/build/outputs/apk/**` – release and
debug, every flavor – verifies the pick against `output-metadata.json` and
then uploads + registers the APK. Debug picks are labelled `[DEBUG]` and gated
(see step 8 above); unsigned ones are labelled `[UNSIGNED]` and warn that
Android cannot install them. Flavor selection is skipped in this mode – add
`--flavor <name>` (or set `APPUPDATE_ANDROID_FLAVOR`) if you want the list
narrowed to one flavor.

> Validation the CLI enforces (in addition to the version / bundle-number /
> dev-vs-prod / project checks your backend already does): packageName comes
> from the selected variant (per-flavor `applicationIdSuffix` supported),
> versionCode/versionName are the values actually inside the APK, and a debug
> APK is never published as a production update. The app re-checks this at
> runtime: `ApkUpdater.getAppInfo()` now also reports `debuggable`, and
> `useApkUpdater()` ignores a debug-flagged update on a release install
> (override with `rejectDebugApkOnRelease: false`, callback
> `onBlockedUpdate`). Your backend should additionally filter
> `buildType === "release"` when serving `GET /projects/get-apk` to a release
> install.

## 🔌 Backend API Contract (APK flow)

The APK flow uses separate endpoints from the bundle flow (`/bundles`), so the
bundle/iOS API surface stays untouched:

### `POST {baseUrl}/apks` — register an uploaded APK (called by the CLI)

Headers: `Authorization: Bearer <API_TOKEN>`, `Api-Key: <APPUPDATE_API_KEY>`

```json
{
  "projectId": "...",
  "environment": "production",
  "platform": "android",
  "packageName": "com.example.android",
  "versionName": "2.1.0",
  "versionCode": 21,
  "buildType": "release",
  "isDebugApk": false,
  "variant": "prod",
  "forceUpdate": false,
  "s3Key": "uploads/production/apk/<uuid>/app.apk",
  "s3Url": "https://<bucket>.s3.<region>.amazonaws.com/uploads/production/apk/<uuid>/app.apk",
  "fileName": "app.apk",
  "fileSize": 25000000
}
```

### `GET {baseUrl}/projects/get-apk?key=<projectKey>&packageName=<applicationId>` — latest APK (called by the app)

Headers: `Api-Key: <APPUPDATE_API_KEY>`

Response (the app reads `versionCode`, `versionName`, `url`, `forceUpdate`, `apkId`,
plus `buildType`/`isDebugApk` for the release-never-gets-debug guard):

```json
{
  "apkId": "apk-record-id",
  "versionCode": 21,
  "versionName": "2.1.0",
  "url": "https://<bucket>.s3.<region>.amazonaws.com/uploads/production/apk/<uuid>/app.apk",
  "forceUpdate": false,
  "buildType": "release",
  "isDebugApk": false
}
```

The app compares `versionCode` against the installed `versionCode` and only
prompts when the server value is higher.

### `POST {baseUrl}/apks/{apkId}/count` — success/failure reporting (called by the app)

Headers: `Api-Key: <APPUPDATE_API_KEY>`

```json
{ "status": "success" }
```

```json
{
  "status": "failure",
  "error": "APK download failed",
  "deviceInfo": {
    "model": "Pixel 6",
    "brand": "Google",
    "systemName": "android",
    "systemVersion": "14"
  }
}
```

## 📝 Notes & Limitations (Android APK flow)

- **Purpose**: this flow targets enterprise / direct-distribution builds. Google
  Play restricts `REQUEST_INSTALL_PACKAGES` usage, so don't publish an APK
  self-updating app on Play without reviewing their policy first.
- **Permissions ("Install unknown apps" + "Display over other apps")**:
  Android never allows an app to grant either programmatically — both are
  special-access toggles only the user can flip in Settings, so there is no
  system dialog an app can invoke directly. The plugin therefore shows its
  OWN **native dialog** — a single `AlertDialog` built from the host app's
  theme and the app's own **logo**, so it looks like a system permission
  popup and needs **zero per-project UI work**. The ONE popup lists **both**
  permission messages together (granted ones are marked "already allowed");
  Continue opens the app's **App info page**, which is a single stable
  intent (`ACTION_APPLICATION_DETAILS_SETTINGS`) that works on every Android
  version — Android 8+ (incl. 13/14/15) lists "Install unknown apps" and
  Android 6+ lists "Display over other apps" — so the user enables **both
  toggles in one place and comes back once**, where the flow re-checks both
  and finally resolves `{ canInstall, canDrawOverlays, ready }`. The APK
  update popup only appears once both are granted, so first launch shows the
  native dialog — never the update popup straight after install. "Install
  unknown apps" is REQUIRED; "Display over other apps" is best-effort
  (auto-reopen helper — the update itself works without it via the
  tap-to-open notification fallback, which needs no overlay). Below Android
  8 the per-app install entry does not exist at all, so the flow does not
  block there — the system installer shows its own "Unknown sources" dialog
  at install time.
- **Progress**: `apkProgress`/`apkProgressInfo` cover the whole journey —
  download 0–90, install-session staging 90–99 (real byte progress from the
  native side), awaiting confirmation 99, success 100. Drive your own screen
  from `isApkUpdating` + `apkPhase` + `apkProgress`.
- **App restart after install**: the OS kills the old process during the
  install. The plugin then tries (1) an instant direct `startActivity()`
  (below Android 10, or whenever a broadcast/foreground privilege window
  still applies), then (2) a `setAlarmClock()` chain whose receiver re-sends
  the launch `PendingIntent` with the Android 14+ creator + sender
  background-start opt-ins (~1s later). If the OS still blocks every
  automatic path, a plain "Update installed — tap to open" notification
  (content intent, no overlay needed) guarantees the way back with one tap —
  a tap always grants the background start. A `MY_PACKAGE_REPLACED`
  receiver covers the system-installer fallback too (where no status
  callback fires). The pending alarm/notification are cancelled if the app
  is already up. On a locked device the activity starts behind the keyguard
  — Android never bypasses the PIN/pattern/fingerprint lock.
  Note: a fully _silent_ reopen cannot be guaranteed on Android 12+
  (background-start restrictions); the notification fallback is the
  documented best-available solution there.
- **Success message**: the target `versionCode` (and `apkId`) is stored before
  the install; on the next launch the hook verifies the installed version and
  fires `onUpdateSuccess` / `apkUpdateJustCompleted` exactly once — use it to
  show the same "App updated successfully" message as the bundle/AppUpdate
  flow. `POST .../apks/{id}/count` success is only reported when a real
  success is observed (cancels/failures count as failure).
- **Retries**: a successfully downloaded APK is reused for the same target, so
  retrying after a cancelled system dialog skips the download. On failure the
  update prompt is re-opened automatically (`apkError` holds the message).
- **Storage**: the APK is downloaded into the app's internal
  `files/apk_updates` directory; previous downloads are removed before each new
  one. No storage permissions are required.
- The CLI reads `versionCode`/`versionName`/`applicationId` from
  `android/app/build.gradle` (Groovy syntax, as used by Capacitor projects).
