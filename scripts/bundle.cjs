#!/usr/bin/env node
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const { input, select, confirm } = require("@inquirer/prompts");

const API_BASE_URL = "https://dev.3rddigital.com/appupdate-api/api/";

function run(command) {
  try {
    console.log(`\n➡️ Running: ${command}\n`);
    execSync(command, { stdio: "inherit" });
  } catch (err) {
    console.error(`❌ Command failed: ${command}`);
    console.error(err.message);
    process.exit(1);
  }
}

async function uploadBundle({ filePath, platform, config }) {
  console.log(`📤 Uploading ${platform} bundle to server...`);

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  const fileStream = fs.createReadStream(filePath);
  const form = new FormData();
  form.append("bundle", fileStream);
  form.append("projectId", config.PROJECT_ID);
  form.append("environment", config.ENVIRONMENT);
  form.append("platform", platform);
  form.append("version", config.VERSION);
  form.append("forceUpdate", String(config.FORCE_UPDATE));

  try {
    const res = await axios.post(`${API_BASE_URL}/bundles`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.API_TOKEN}`,
      },
    });
    console.log(
      `✅ ${platform} bundle uploaded! Response:`,
      JSON.stringify(res.data, null, 2)
    );
  } catch (err) {
    console.error(`❌ ${platform} bundle upload failed!`);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error("Message:", err.message);
    }
    process.exit(1);
  }
}

async function getCommonConfig() {
  console.log(`\n⚙️  Enter common configuration for the app\n`);

  const API_TOKEN = await input({
    message: `Enter API Token:`,
    validate: (val) => (val.trim() ? true : "API Token required"),
  });

  const PROJECT_ID = await input({
    message: `Enter Project ID:`,
    validate: (val) => (val.trim() ? true : "Project ID required"),
  });

  const ENVIRONMENT = await select({
    message: `Select Environment:`,
    choices: [
      { name: "development", value: "development" },
      { name: "production", value: "production" },
    ],
  });

  return { API_TOKEN, PROJECT_ID, ENVIRONMENT };
}

function getPlatformAppVersion(platform) {
  try {
    let projectRoot = path.resolve(__dirname);
    while (
      projectRoot.includes("node_modules") &&
      !fs.existsSync(path.join(projectRoot, "package.json"))
    ) {
      projectRoot = path.resolve(projectRoot, "..");
    }

    if (projectRoot.includes("node_modules")) {
      projectRoot = path.resolve(projectRoot, "../../");
    }

    if (platform === "android") {
      const gradlePath = path.join(
        projectRoot,
        "android",
        "app",
        "build.gradle"
      );
      if (!fs.existsSync(gradlePath)) {
        console.warn(`⚠️ Android build.gradle not found at ${gradlePath}`);
        return null;
      }
      const gradleContent = fs.readFileSync(gradlePath, "utf8");
      const match = gradleContent.match(/versionName\s+"([\d.]+)"/);
      if (match && match[1]) return match[1];
      console.warn("⚠️ Could not find versionName in build.gradle.");
    } else if (platform === "ios") {
      const iosDir = path.join(projectRoot, "ios");
      if (!fs.existsSync(iosDir)) {
        console.warn(`⚠️ iOS folder not found at ${iosDir}`);
        return null;
      }

      function findXcodeProj(dir) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const fullPath = path.join(dir, f);
          if (fs.statSync(fullPath).isDirectory()) {
            if (f.endsWith(".xcodeproj")) return fullPath;
            const nested = findXcodeProj(fullPath);
            if (nested) return nested;
          }
        }
        return null;
      }

      const xcodeProjPath = findXcodeProj(iosDir);
      if (!xcodeProjPath) {
        console.warn("⚠️ .xcodeproj not found inside ios directory.");
        return null;
      }

      const pbxprojPath = path.join(xcodeProjPath, "project.pbxproj");
      if (!fs.existsSync(pbxprojPath)) {
        console.warn("⚠️ project.pbxproj not found.");
        return null;
      }

      const pbxprojContent = fs.readFileSync(pbxprojPath, "utf8");
      const match = pbxprojContent.match(/MARKETING_VERSION\s*=\s*([\d.]+);/);
      if (match && match[1]) return match[1];
      console.warn("⚠️ Could not find MARKETING_VERSION in project.pbxproj.");
    }
  } catch (err) {
    console.warn(`⚠️ Failed to read ${platform} version:`, err.message);
  }

  return null;
}

async function getPlatformConfig(platform) {
  console.log(`\n⚙️  Enter configuration for ${platform.toUpperCase()}\n`);

  let detectedVersion = getPlatformAppVersion(platform);
  if (detectedVersion) {
    console.log(`📱 Detected ${platform} version: ${detectedVersion}`);
  } else {
    console.warn(`⚠️ Could not detect ${platform} version automatically.`);
    detectedVersion = await input({
      message: `(${platform}) Enter App Version (e.g. 1.0.0):`,
      validate: (val) => (val.trim() ? true : "Version required"),
    });
  }

  const FORCE_UPDATE = await confirm({
    message: `(${platform}) Force Update?`,
    default: false,
  });

  return { VERSION: detectedVersion, FORCE_UPDATE };
}

function getAppId() {
  const configPath = path.join(process.cwd(), "capacitor.config.ts");
  if (!fs.existsSync(configPath)) {
    console.error("❌ capacitor.config.ts not found!");
    process.exit(1);
  }
  const content = fs.readFileSync(configPath, "utf-8");
  const match = content.match(/appId:\s*['"`](.*?)['"`]/);
  if (!match) {
    console.error("❌ Could not extract appId from capacitor.config.ts");
    process.exit(1);
  }
  return match[1];
}

function getAppVersion() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error("❌ package.json not found!");
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version || "0.0.0";
}

function getLatestCapgoZip() {
  const appId = getAppId();
  const version = getAppVersion();
  const expectedPrefix = `${appId}_${version}`;

  const files = fs.readdirSync(process.cwd());
  const zipFiles = files.filter(
    (f) => f.endsWith(".zip") && f.startsWith(expectedPrefix)
  );

  if (!zipFiles.length) {
    console.error(`❌ No Capgo bundle zip found matching: ${expectedPrefix}`);
    process.exit(1);
  }

  zipFiles.sort(
    (a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime()
  );
  return path.join(process.cwd(), zipFiles[0]);
}

function buildBundle() {
  console.log("📦 Building web app and Capgo bundle...");

  // Build web app once
  run("npm run build");

  // Create Capgo zip
  run("npx @capgo/cli@latest bundle zip");

  // Detect generated zip
  const outputPath = getLatestCapgoZip();
  console.log(`✅ Bundle created at ${outputPath}`);
  return outputPath;
}

(async () => {
  try {
    const platformArg = process.argv[2];
    if (!platformArg) {
      console.error("❌ Please specify a platform: android | ios | all");
      process.exit(1);
    }

    // Get common config once
    const commonConfig = await getCommonConfig();

    // Build bundle once
    const bundleFile = buildBundle();

    // Android upload
    if (platformArg === "android" || platformArg === "all") {
      const androidConfig = await getPlatformConfig("android");
      await uploadBundle({
        filePath: bundleFile,
        platform: "android",
        config: { ...commonConfig, ...androidConfig },
      });
    }

    // iOS upload
    if (platformArg === "ios" || platformArg === "all") {
      const iosConfig = await getPlatformConfig("ios");
      await uploadBundle({
        filePath: bundleFile,
        platform: "ios",
        config: { ...commonConfig, ...iosConfig },
      });
    }

    console.log("\n🎉 All tasks completed successfully!");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
