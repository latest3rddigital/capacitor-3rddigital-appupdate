#!/usr/bin/env node
require("dotenv").config();
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { input, select, confirm } = require("@inquirer/prompts");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");

const APPUPDATE_BASE_URL = process.env.APPUPDATE_BASE_URL;
const APPUPDATE_API_KEY = process.env.APPUPDATE_API_KEY;
const APPUPDATE_AWS_REGION = process.env.APPUPDATE_AWS_REGION;
const APPUPDATE_AWS_ACCESS_KEY_ID = process.env.APPUPDATE_AWS_ACCESS_KEY_ID;
const APPUPDATE_AWS_SECRET_ACCESS_KEY =
  process.env.APPUPDATE_AWS_SECRET_ACCESS_KEY;
const APPUPDATE_AWS_BUCKET_NAME = process.env.APPUPDATE_AWS_BUCKET_NAME;

function DecriptEnv(wrappedKey) {
  if (!wrappedKey) {
    return "";
  }

  if (typeof wrappedKey !== "string")
    throw new TypeError("wrappedKey must be a string");

  if (wrappedKey.length <= 8) throw new Error("wrappedKey too short to unwrap");
  const trimmed = wrappedKey.slice(4, -2);
  const result = trimmed.slice(0, 2) + trimmed.slice(4);
  return result;
}

const s3Client = new S3Client({
  region: DecriptEnv(APPUPDATE_AWS_REGION),
  credentials: {
    accessKeyId: DecriptEnv(APPUPDATE_AWS_ACCESS_KEY_ID),
    secretAccessKey: DecriptEnv(APPUPDATE_AWS_SECRET_ACCESS_KEY),
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

async function uploadFileToS3(filePath, bucketName, folder) {
  const fileName = path.basename(filePath);
  const cleanFileName = fileName.replace(/\s+/g, "_");
  const uniqueId = uuidv4();
  const fileKey = `${folder}/${uniqueId}/${cleanFileName}`;
  const fileBuffer = fs.readFileSync(filePath);

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: fileKey,
      Body: fileBuffer,
      ContentType: "application/zip",
      ACL: "public-read",
    });

    await s3Client.send(command);

    const region = DecriptEnv(APPUPDATE_AWS_REGION);
    const location = `https://${bucketName}.s3.${region}.amazonaws.com/${fileKey}`;

    return {
      Location: location,
      Key: fileKey,
      Bucket: bucketName,
    };
  } catch (error) {
    console.error("❌ S3 Upload Error:", error);
    throw error;
  }
}

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

  try {
    const s3Result = await uploadFileToS3(
      filePath,
      DecriptEnv(APPUPDATE_AWS_BUCKET_NAME),
      config.ENVIRONMENT === "development"
        ? "uploads/development"
        : "uploads/production",
    );

    console.log(`✅ S3 Upload Complete: ${s3Result.Key}`);
    console.log(`📝 Step 2: Registering with backend API...`);

    const stats = fs.statSync(filePath);

    const payload = {
      projectId: config.PROJECT_ID,
      environment: config.ENVIRONMENT,
      platform: platform,
      version: config.VERSION,
      forceUpdate: config.FORCE_UPDATE,
      s3Key: s3Result.Key,
      s3Url: s3Result.Location,
      fileName: path.basename(filePath),
      fileSize: stats.size,
    };

    const res = await axios.post(`${APPUPDATE_BASE_URL}/bundles`, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.API_TOKEN}`,
        "Api-Key": APPUPDATE_API_KEY,
      },
    });

    console.log(
      `✅ ${platform} bundle uploaded! Response:`,
      JSON.stringify(res.data, null, 2),
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

  let ENVIRONMENT;
  let isEnvironmentConfirmed = false;

  while (!isEnvironmentConfirmed) {
    ENVIRONMENT = await select({
      message: `Select Environment:`,
      choices: [
        { name: "development", value: "development" },
        { name: "production", value: "production" },
      ],
    });

    isEnvironmentConfirmed = await confirm({
      message: `Continue with ${ENVIRONMENT} environment?`,
      default: true,
    });
  }

  return { API_TOKEN, PROJECT_ID, ENVIRONMENT };
}

function extractBracedBlock(content, startIndex) {
  const openIndex = content.indexOf("{", startIndex);
  if (openIndex === -1) return null;

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];
    const prevChar = content[index - 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (prevChar === "*" && char === "/") inBlockComment = false;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inTemplate) {
      if (char === "/" && nextChar === "/") {
        inLineComment = true;
        index += 1;
        continue;
      }

      if (char === "/" && nextChar === "*") {
        inBlockComment = true;
        index += 1;
        continue;
      }
    }

    if (!inDoubleQuote && !inTemplate && char === "'" && prevChar !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && !inTemplate && char === '"' && prevChar !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === "`" && prevChar !== "\\") {
      inTemplate = !inTemplate;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inTemplate) continue;

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: content.slice(openIndex + 1, index),
          start: openIndex,
          end: index,
        };
      }
    }
  }

  return null;
}

function extractNamedBlock(content, blockName) {
  const blockRegex = new RegExp(`\\b${blockName}\\b\\s*\\{`, "m");
  const match = blockRegex.exec(content);
  if (!match) return null;
  return extractBracedBlock(content, match.index);
}

function parseTopLevelNamedBlocks(content) {
  const blocks = [];
  let cursor = 0;

  while (cursor < content.length) {
    const remainder = content.slice(cursor);
    const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(remainder);

    if (!nameMatch) {
      cursor += 1;
      continue;
    }

    const nameIndex = cursor + nameMatch.index;
    const name = nameMatch[1];
    const block = extractBracedBlock(content, nameIndex);

    if (!block) break;

    blocks.push({ name, content: block.content });
    cursor = block.end + 1;
  }

  return blocks;
}

function readQuotedGradleValue(blockContent, key) {
  const match = blockContent.match(
    new RegExp(`\\b${key}\\b\\s+["']([^"']+)["']`),
  );
  return match?.[1] ?? null;
}

function getProjectRoot() {
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

  return projectRoot;
}

function findFirstXcodeProj(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file.endsWith(".xcodeproj")) return fullPath;
      const nested = findFirstXcodeProj(fullPath);
      if (nested) return nested;
    }
  }
  return null;
}

function getAndroidProjectMetadata() {
  const projectRoot = getProjectRoot();
  const gradlePath = path.join(projectRoot, "android", "app", "build.gradle");
  if (!fs.existsSync(gradlePath)) {
    console.warn(`⚠️ Android build.gradle not found at ${gradlePath}`);
    return null;
  }

  const gradleContent = fs.readFileSync(gradlePath, "utf8");
  const defaultConfigBlock = extractNamedBlock(gradleContent, "defaultConfig");
  const productFlavorsBlock = extractNamedBlock(
    gradleContent,
    "productFlavors",
  );

  const defaultAppId =
    readQuotedGradleValue(defaultConfigBlock?.content ?? "", "applicationId") ??
    getAppId();
  const defaultVersion =
    readQuotedGradleValue(defaultConfigBlock?.content ?? "", "versionName") ??
    getAppVersion();

  const flavors = parseTopLevelNamedBlocks(
    productFlavorsBlock?.content ?? "",
  ).map(({ name, content }) => {
    const flavorAppId = readQuotedGradleValue(content, "applicationId");
    const flavorAppIdSuffix = readQuotedGradleValue(
      content,
      "applicationIdSuffix",
    );
    const flavorVersion = readQuotedGradleValue(content, "versionName");
    const flavorVersionSuffix = readQuotedGradleValue(
      content,
      "versionNameSuffix",
    );

    return {
      name,
      appId: flavorAppId ?? `${defaultAppId}${flavorAppIdSuffix ?? ""}`,
      version: flavorVersion ?? `${defaultVersion}${flavorVersionSuffix ?? ""}`,
    };
  });

  return {
    defaultConfig: {
      name: "default",
      label: "Default",
      appId: defaultAppId,
      version: defaultVersion,
    },
    flavors,
  };
}

async function getAndroidFlavorSelection() {
  const metadata = getAndroidProjectMetadata();
  if (!metadata) return null;

  if (!metadata.flavors.length) {
    return metadata.defaultConfig;
  }

  let selectedFlavor;
  let isFlavorConfirmed = false;

  while (!isFlavorConfirmed) {
    selectedFlavor = await select({
      message: "Select Android flavor:",
      choices: [
        {
          name: `Default (${metadata.defaultConfig.appId} / ${metadata.defaultConfig.version})`,
          value: metadata.defaultConfig,
        },
        ...metadata.flavors.map((flavor) => ({
          name: `${flavor.name} (${flavor.appId} / ${flavor.version})`,
          value: {
            ...flavor,
            label: flavor.name,
          },
        })),
      ],
    });

    isFlavorConfirmed = await confirm({
      message: `Continue with Android flavor ${selectedFlavor.label ?? selectedFlavor.name}?`,
      default: true,
    });
  }

  return selectedFlavor;
}

function parsePbxprojObjectsByIsa(pbxprojContent, isa) {
  const objectRegex = new RegExp(
    `([A-F0-9]{24}) /\\* ([^*]+) \\*/ = \\{[\\s\\S]*?isa = ${isa};([\\s\\S]*?)\\n\\s*\\};`,
    "g",
  );
  const objects = [];
  let match;

  while ((match = objectRegex.exec(pbxprojContent)) !== null) {
    objects.push({
      id: match[1],
      comment: match[2].trim(),
      body: match[3],
    });
  }

  return objects;
}

function readPbxValue(body, key) {
  const match = body.match(new RegExp(`\\b${key}\\s*=\\s*([^;]+);`));
  return match?.[1]?.trim() ?? null;
}

function cleanPbxString(value) {
  if (!value) return null;
  return value.replace(/^"(.*)"$/, "$1").trim();
}

function parsePbxArray(body, key) {
  const match = body.match(new RegExp(`\\b${key}\\s*=\\s*\\(([\\s\\S]*?)\\);`));
  if (!match) return [];

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/,$/, ""))
    .map((line) => {
      const idMatch = line.match(/^([A-F0-9]{24})/);
      return idMatch?.[1] ?? null;
    })
    .filter(Boolean);
}

function isAppLikeTarget(targetName, productType) {
  if (productType?.includes("application")) return true;

  return ![
    "Tests",
    "UITests",
    "UnitTests",
    "NotificationService",
    "Extension",
    "Widget",
  ].some((suffix) => targetName.endsWith(suffix));
}

function getIosProjectMetadata() {
  const projectRoot = getProjectRoot();
  const iosDir = path.join(projectRoot, "ios");
  if (!fs.existsSync(iosDir)) {
    console.warn(`⚠️ iOS folder not found at ${iosDir}`);
    return null;
  }

  const xcodeProjPath = findFirstXcodeProj(iosDir);
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
  const configObjects = parsePbxprojObjectsByIsa(
    pbxprojContent,
    "XCBuildConfiguration",
  );
  const configMap = new Map(
    configObjects.map((config) => [
      config.id,
      {
        name: cleanPbxString(readPbxValue(config.body, "name")),
        version: cleanPbxString(readPbxValue(config.body, "MARKETING_VERSION")),
        appId: cleanPbxString(
          readPbxValue(config.body, "PRODUCT_BUNDLE_IDENTIFIER"),
        ),
        productName: cleanPbxString(readPbxValue(config.body, "PRODUCT_NAME")),
      },
    ]),
  );

  const configListObjects = parsePbxprojObjectsByIsa(
    pbxprojContent,
    "XCConfigurationList",
  );
  const configListMap = new Map(
    configListObjects.map((configList) => [
      configList.id,
      {
        defaultName: cleanPbxString(
          readPbxValue(configList.body, "defaultConfigurationName"),
        ),
        buildConfigurations: parsePbxArray(
          configList.body,
          "buildConfigurations",
        ),
      },
    ]),
  );

  const targetObjects = parsePbxprojObjectsByIsa(
    pbxprojContent,
    "PBXNativeTarget",
  );
  const targets = targetObjects
    .map((target) => {
      const targetName = cleanPbxString(readPbxValue(target.body, "name"));
      const productType = cleanPbxString(
        readPbxValue(target.body, "productType"),
      );
      const configListId = cleanPbxString(
        readPbxValue(target.body, "buildConfigurationList"),
      )?.match(/^([A-F0-9]{24})/)?.[1];

      if (
        !targetName ||
        !configListId ||
        !isAppLikeTarget(targetName, productType)
      ) {
        return null;
      }

      const configList = configListMap.get(configListId);
      const buildConfigs =
        configList?.buildConfigurations
          .map((configId) => configMap.get(configId))
          .filter(Boolean) ?? [];

      const preferredConfig =
        buildConfigs.find(
          (config) => config.name === configList?.defaultName,
        ) ??
        buildConfigs.find((config) => config.name === "Release") ??
        buildConfigs[0];

      if (!preferredConfig) return null;

      const buildConfigurationLabel = preferredConfig.name
        ? ` [${preferredConfig.name}]`
        : "";

      return {
        name: targetName,
        label: `${targetName}${buildConfigurationLabel}`,
        appId: preferredConfig.appId ?? getAppId(),
        version: preferredConfig.version ?? null,
        productName: preferredConfig.productName ?? targetName,
        buildConfiguration: preferredConfig.name ?? null,
      };
    })
    .filter(Boolean);

  if (!targets.length) {
    const fallbackVersionMatch = pbxprojContent.match(
      /MARKETING_VERSION\s*=\s*([^;]+);/,
    );

    return {
      defaultConfig: {
        name: "default",
        label: "Default",
        appId: getAppId(),
        version: cleanPbxString(fallbackVersionMatch?.[1]) ?? null,
      },
      targets: [],
    };
  }

  const uniqueTargets = targets.filter(
    (target, index, allTargets) =>
      allTargets.findIndex((candidate) => candidate.name === target.name) ===
      index,
  );

  return {
    defaultConfig: uniqueTargets[0],
    targets: uniqueTargets,
  };
}

async function getIosTargetSelection() {
  const metadata = getIosProjectMetadata();
  if (!metadata) return null;

  if (metadata.targets.length <= 1) {
    return metadata.defaultConfig;
  }

  let selectedTarget;
  let isTargetConfirmed = false;

  while (!isTargetConfirmed) {
    selectedTarget = await select({
      message: "Select iOS target:",
      choices: metadata.targets.map((target) => ({
        name: `${target.label} (${target.appId} / ${target.version ?? "unknown version"})`,
        value: target,
      })),
    });

    isTargetConfirmed = await confirm({
      message: `Continue with iOS target ${selectedTarget.label ?? selectedTarget.name}?`,
      default: true,
    });
  }

  return selectedTarget;
}

function getPlatformAppVersion(platform, selection) {
  try {
    if (platform === "android") {
      if (selection?.version) return selection.version;

      const metadata = getAndroidProjectMetadata();
      if (metadata?.defaultConfig.version)
        return metadata.defaultConfig.version;
      console.warn("⚠️ Could not find Android versionName in build.gradle.");
    } else if (platform === "ios") {
      if (selection?.version) return selection.version;

      const metadata = getIosProjectMetadata();
      if (metadata?.defaultConfig.version)
        return metadata.defaultConfig.version;
      console.warn("⚠️ Could not find MARKETING_VERSION in project.pbxproj.");
    }
  } catch (err) {
    console.warn(`⚠️ Failed to read ${platform} version:`, err.message);
  }

  return null;
}

async function getPlatformConfig(platform) {
  console.log(`\n⚙️  Enter configuration for ${platform.toUpperCase()}\n`);

  const selection =
    platform === "android"
      ? await getAndroidFlavorSelection()
      : platform === "ios"
        ? await getIosTargetSelection()
        : null;

  if (platform === "android" && selection?.label) {
    console.log(
      `📦 Selected Android flavor: ${selection.label} (${selection.appId})`,
    );
  }

  if (platform === "ios" && selection?.label) {
    console.log(
      `🍎 Selected iOS target: ${selection.label} (${selection.appId})`,
    );
  }

  let detectedVersion = getPlatformAppVersion(platform, selection);
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

  return {
    VERSION: detectedVersion,
    FORCE_UPDATE,
    APP_ID: selection?.appId ?? getAppId(),
    FLAVOR: selection?.name ?? null,
  };
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

async function getLatestCapgoZip({ appId, version }) {
  const files = fs.readdirSync(process.cwd());
  const zipFiles = files.filter((file) => file.endsWith(".zip"));

  if (!zipFiles.length) {
    console.error("❌ No Capgo bundle zip found in the current project.");
    process.exit(1);
  }

  const sortedZipFiles = zipFiles.sort(
    (a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime(),
  );

  if (appId && version) {
    const expectedPrefix = `${appId}_${version}`;
    const matchedFiles = sortedZipFiles.filter((file) =>
      file.startsWith(expectedPrefix),
    );

    if (matchedFiles.length === 1) {
      return path.join(process.cwd(), matchedFiles[0]);
    }

    if (matchedFiles.length > 1) {
      const selectedZip = await select({
        message: `Multiple Capgo bundles found for ${expectedPrefix}. Select one:`,
        choices: matchedFiles.map((file) => ({ name: file, value: file })),
      });
      return path.join(process.cwd(), selectedZip);
    }

    console.warn(
      `⚠️ No generated zip matched ${expectedPrefix}. Please choose the correct bundle file.`,
    );
  }

  if (sortedZipFiles.length === 1) {
    return path.join(process.cwd(), sortedZipFiles[0]);
  }

  const selectedZip = await select({
    message: "Select the generated Capgo bundle zip:",
    choices: sortedZipFiles.slice(0, 10).map((file) => ({
      name: file,
      value: file,
    })),
  });

  return path.join(process.cwd(), selectedZip);
}

async function buildBundle(buildCommand, bundleMetadata) {
  console.log("📦 Building web app and Capgo bundle...");

  // Build web app once
  run(buildCommand);

  // Create Capgo zip
  run("npx @capgo/cli@latest bundle zip");

  // Detect generated zip
  const outputPath = await getLatestCapgoZip(bundleMetadata);
  console.log(`✅ Bundle created at ${outputPath}`);
  return outputPath;
}

(async () => {
  try {
    const rawArg = process.argv[2];
    if (!rawArg) {
      console.error(
        "❌ Please specify a platform: android | ios | all (e.g., all:dev)",
      );
      process.exit(1);
    }

    const [platformArg, envSuffix] = rawArg.split(":");

    const commonConfig = await getCommonConfig();
    const platformConfigs = {};

    if (platformArg === "android" || platformArg === "all") {
      platformConfigs.android = await getPlatformConfig("android");
    }

    if (platformArg === "ios" || platformArg === "all") {
      platformConfigs.ios = await getPlatformConfig("ios");
    }

    const buildCommand = envSuffix
      ? `npm run build:${envSuffix}`
      : "npm run build";

    const bundleFile = await buildBundle(buildCommand, {
      appId:
        platformConfigs.android?.APP_ID ??
        platformConfigs.ios?.APP_ID ??
        getAppId(),
      version:
        platformConfigs.android?.VERSION ??
        platformConfigs.ios?.VERSION ??
        getAppVersion(),
    });

    // Android upload
    if (platformArg === "android" || platformArg === "all") {
      await uploadBundle({
        filePath: bundleFile,
        platform: "android",
        config: { ...commonConfig, ...platformConfigs.android },
      });
    }

    // iOS upload
    if (platformArg === "ios" || platformArg === "all") {
      await uploadBundle({
        filePath: bundleFile,
        platform: "ios",
        config: { ...commonConfig, ...platformConfigs.ios },
      });
    }

    console.log("\n🎉 All tasks completed successfully!");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
