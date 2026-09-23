#!/usr/bin/env node
/**
 * appupdate-apk
 *
 * Dedicated CLI for the Android in-app APK update flow. Fully separate from
 * `bundle.cjs` (the OTA bundle flow) so it can never affect it.
 *
 * Pipeline:
 *   1. Prompts (API token, project id, environment, Android flavor, versions)
 *   2. Web build            -> npm run build[:env]
 *   3. Native sync          -> npx cap sync android
 *   4. Release APK build    -> ./gradlew assemble<Flavor>Release
 *                              (signing is resolved dynamically: env vars ->
 *                               android/keystore.properties -> keystore scan,
 *                               passed via -Pandroid.injected.signing.*)
 *   5. Verify the built APK -> reads AGP's output-metadata.json so the version
 *                              code/name + applicationId that get registered
 *                              always match the APK that was produced
 *   6. Upload APK to S3     -> uploads/<environment>/apk/<uuid>/...
 *   7. Register with server -> POST {baseUrl}/apks
 *
 * Usage:
 *   npx appupdate-apk                        # build with `npm run build`, then upload
 *   npx appupdate-apk dev                    # build with `npm run build:dev`, then upload
 *   npx appupdate-apk live                   # build with `npm run build:live`, then upload
 *   npx appupdate-apk upload                 # skip building: pick ANY existing APK (release + debug)
 *   npx appupdate-apk upload dev             # upload-only, records environment `dev`
 *   npx appupdate-apk --apk <path>           # upload this exact APK (skips scan)
 *   npx appupdate-apk --help                 # full flag reference
 *
 * Flags (can be combined, in any order):
 *   --apk <path> | --apk=<path>   upload this exact APK
 *   --flavor <name>               Android product flavor to build / look for
 *   --env <name>                  web-build suffix override (same as `dev` positional)
 *   --project <id>                project id (skips prompt)
 *   --api-token <token>           API token (skips prompt)
 *   --force / --no-force          forceUpdate flag (skips prompt)
 *   --allow-debug-apk             allow uploading a debuggable (debug) APK
 *   --yes, -y                     accept all auto-detected values without confirming
 */
require("dotenv").config();
const { execSync, execFileSync } = require("child_process");
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

// Keystore configuration - all dynamic, all optional.
const APPUPDATE_KEYSTORE_PATH = process.env.APPUPDATE_KEYSTORE_PATH;
const APPUPDATE_KEYSTORE_PASSWORD = process.env.APPUPDATE_KEYSTORE_PASSWORD;
const APPUPDATE_KEYSTORE_ALIAS = process.env.APPUPDATE_KEYSTORE_ALIAS;
const APPUPDATE_KEY_PASSWORD = process.env.APPUPDATE_KEY_PASSWORD;
const APPUPDATE_KEYSTORE_PROPERTIES_FILE =
  process.env.APPUPDATE_KEYSTORE_PROPERTIES_FILE;

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

/**
 * Fails fast (with a clear message) when the required .env configuration is
 * missing, instead of letting the AWS SDK throw a cryptic error like
 * "Region is missing" while the module is being loaded.
 */
function validateEnvConfig() {
  const missing = [
    ["APPUPDATE_BASE_URL", APPUPDATE_BASE_URL],
    ["APPUPDATE_API_KEY", APPUPDATE_API_KEY],
    ["APPUPDATE_AWS_REGION", APPUPDATE_AWS_REGION],
    ["APPUPDATE_AWS_ACCESS_KEY_ID", APPUPDATE_AWS_ACCESS_KEY_ID],
    ["APPUPDATE_AWS_SECRET_ACCESS_KEY", APPUPDATE_AWS_SECRET_ACCESS_KEY],
    ["APPUPDATE_AWS_BUCKET_NAME", APPUPDATE_AWS_BUCKET_NAME],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    console.error(
      `❌ Missing required environment variables: ${missing.join(", ")}\n` +
        "   Add them to a .env file in your app root (see .env.example in capacitor-3rddigital-appupdate).",
    );
    process.exit(1);
  }
}

let s3ClientInstance = null;

/** Lazily created so the CLI can print its usage without a .env file. */
function getS3Client() {
  if (!s3ClientInstance) {
    s3ClientInstance = new S3Client({
      region: DecriptEnv(APPUPDATE_AWS_REGION),
      credentials: {
        accessKeyId: DecriptEnv(APPUPDATE_AWS_ACCESS_KEY_ID),
        secretAccessKey: DecriptEnv(APPUPDATE_AWS_SECRET_ACCESS_KEY),
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return s3ClientInstance;
}

function run(command, options = {}) {
  try {
    console.log(`\n➡️ Running: ${command}\n`);
    // Forward cwd so web builds / cap sync / gradle always run inside the
    // consumer project even when this file is resolved from node_modules/.bin.
    execSync(command, {
      stdio: "inherit",
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    });
  } catch (err) {
    console.error(`❌ Command failed: ${command}`);
    if (err && err.message) console.error(err.message);
    if (/npm run build/.test(command)) {
      console.error(
        "   Hint: make sure that build script exists in the app package.json " +
          '(e.g. "build", "build:dev"). Check the name or pass another env suffix.',
      );
    }
    if (/cap sync/.test(command)) {
      console.error(
        "   Hint: run this from the app root (capacitor.config.* + android/ present) " +
          "and ensure @capacitor/cli is installed.",
      );
    }
    process.exit(1);
  }
}

/**
 * Minimal CLI parser. Supports (in any order):
 *   positional: [mode] [env]  -> mode = "upload" | web-build env suffix
 *     e.g. `appupdate-apk`, `appupdate-apk dev`, `appupdate-apk upload`,
 *          `appupdate-apk upload dev`
 *   flags: --apk <path>|--apk=<path>  --flavor <n>  --env <n>
 *          --project <id>  --api-token <t>  --force | --no-force
 *          --allow-debug-apk  --yes|-y  --help|-h|help
 */
function parseCliArgs(argv) {
  const cli = {
    mode: "build",
    envSuffix: undefined,
    apkPath: undefined,
    flavor: undefined,
    projectId: undefined,
    apiToken: undefined,
    forceUpdate: undefined,
    allowDebugApk: false,
    assumeYes: false,
    help: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const peek = argv[i + 1];
    const takeValue = () => {
      if (peek === undefined || String(peek).startsWith("--")) {
        console.error(`❌ Flag ${arg} expects a value.`);
        process.exit(1);
      }
      i++;
      return peek;
    };
    if (arg === "--apk") cli.apkPath = takeValue();
    else if (arg.startsWith("--apk=")) cli.apkPath = arg.slice("--apk=".length);
    else if (arg === "--flavor") cli.flavor = takeValue();
    else if (arg.startsWith("--flavor="))
      cli.flavor = arg.slice("--flavor=".length);
    else if (arg === "--env") cli.envSuffix = takeValue();
    else if (arg.startsWith("--env="))
      cli.envSuffix = arg.slice("--env=".length);
    else if (arg === "--project") cli.projectId = takeValue();
    else if (arg.startsWith("--project="))
      cli.projectId = arg.slice("--project=".length);
    else if (arg === "--api-token") cli.apiToken = takeValue();
    else if (arg.startsWith("--api-token="))
      cli.apiToken = arg.slice("--api-token=".length);
    else if (arg === "--force") cli.forceUpdate = true;
    else if (arg === "--no-force") cli.forceUpdate = false;
    else if (arg === "--allow-debug-apk") cli.allowDebugApk = true;
    else if (arg === "--yes" || arg === "-y") cli.assumeYes = true;
    else if (arg === "--help" || arg === "-h" || arg === "help")
      cli.help = true;
    else if (arg.startsWith("-")) {
      console.error(`❌ Unknown flag "${arg}". Run with --help for usage.`);
      process.exit(1);
    } else positionals.push(arg);
  }
  if (positionals.length > 0) {
    if (positionals[0] === "upload") {
      cli.mode = "upload";
      if (positionals[1] && cli.envSuffix === undefined)
        cli.envSuffix = positionals[1];
      if (positionals.length > 2) {
        console.error(
          "❌ Too many arguments. Usage: appupdate-apk [upload [env]] [flags]",
        );
        process.exit(1);
      }
    } else {
      cli.mode = "build";
      if (cli.envSuffix === undefined) cli.envSuffix = positionals[0];
      if (positionals.length > 1) {
        console.error(
          "❌ Too many arguments. Usage: appupdate-apk [dev|live|...] | upload [env]",
        );
        process.exit(1);
      }
    }
  }
  // The suffix maps 1:1 to an npm script (`build:<suffix>`), so it must be
  // allowed to contain the separators real projects use, e.g.
  //   "dev:test"     -> build:dev:test     (.env.dev.test)
  //   "dev.test"     -> build:dev.test
  //   "local-tablet" -> build:local-tablet
  if (
    cli.envSuffix &&
    !/^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/i.test(cli.envSuffix)
  ) {
    console.error(
      `❌ Invalid environment suffix "${cli.envSuffix}". ` +
        "Use e.g. dev | live | prod | dev:test | local-tablet.",
    );
    process.exit(1);
  }
  return cli;
}

/**
 * Runs an executable with an argument array (no shell involved). This is used
 * for gradle so keystore paths / passwords containing spaces or shell-special
 * characters can never break (or leak into) the shell command.
 */
function runCommand(executable, args, options = {}) {
  const printable = `${executable} ${args
    .map((arg) => (/^-P.*password=/i.test(arg) ? "-P***=***" : arg))
    .join(" ")}`;
  try {
    console.log(`\n➡️ Running: ${printable}\n`);
    // Ensure the gradle wrapper is executable (fresh checkouts lose +x).
    if (
      path.basename(executable).startsWith("gradlew") &&
      process.platform !== "win32"
    ) {
      try {
        fs.accessSync(executable, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(executable, 0o755);
          console.log("🔧 Made gradlew executable (chmod +x).");
        } catch {
          // ignore - try to run anyway
        }
      }
    }
    execFileSync(executable, args, {
      stdio: "inherit",
      cwd: options.cwd || process.cwd(),
      shell: options.shell || false,
      // Gradle needs a JDK 21+ (Capacitor 7). The caller passes an explicit
      // JAVA_HOME here so the build never inherits an incompatible shell JDK.
      env: options.env || process.env,
    });
  } catch (err) {
    console.error(`❌ Command failed: ${printable}`);
    if (err.message) console.error(err.message);
    process.exit(1);
  }
}

function normalizeBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function joinUrl(base, route) {
  const cleanBase = normalizeBaseUrl(base);
  const cleanRoute = route.startsWith("/") ? route : `/${route}`;
  return `${cleanBase}${cleanRoute}`;
}

/** npm scripts declared by the consumer app (used to validate build cmds). */
function readPackageScripts(projectRoot) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    );
    return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    return {};
  }
}

/**
 * Resolves `npm run build[:env]` and fails fast with an actionable message
 * when the consumer app does not define that script (previously surfaced
 * as a bare "Command failed" with no hint).
 */
function resolveWebBuildCommand(projectRoot, envSuffix) {
  const scripts = readPackageScripts(projectRoot);
  const candidates = envSuffix ? [`build:${envSuffix}`, "build"] : ["build"];
  for (const name of candidates) {
    if (scripts[name]) {
      if (envSuffix && name === "build") {
        console.warn(
          `⚠️ No "build:${envSuffix}" script in package.json - falling back to "npm run build".`,
        );
      }
      return `npm run ${name}`;
    }
  }
  console.error(
    `❌ No web-build script found in ${path.join(projectRoot, "package.json")}.\n` +
      `   Expected one of: ${candidates.map((c) => `"${c}"`).join(", ")}.\n` +
      `   Add a "build" script (e.g. "vite build") or pass an env matching an existing script.`,
  );
  process.exit(1);
}

function getProjectRoot() {
  // The consumer project root is (almost) always the current working
  // directory when the CLI is invoked via npx from the app folder. Prefer it
  // whenever it looks like a project (package.json present).
  const cwd = process.cwd();
  try {
    if (fs.existsSync(path.join(cwd, "package.json"))) return cwd;
  } catch {
    // fall through to script-relative resolution
  }
  // Fallback: walk up from this script (covers programmatic / global usage).
  // When installed as a dependency the script lives at
  //   <project>/node_modules/capacitor-3rddigital-appupdate/scripts
  // so climbing past node_modules lands on the consumer project root.
  let dir = path.resolve(__dirname);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      // If we are inside the published package itself, keep climbing past it.
      if (dir.includes("node_modules")) {
        dir = path.resolve(dir, "..");
        continue;
      }
      return dir;
    }
    // Climbing out of node_modules/<pkg>/scripts -> <project> root.
    if (path.basename(dir) === "node_modules") {
      return path.resolve(dir, "..");
    }
    dir = path.resolve(dir, "..");
  }
  return cwd;
}

function getAppId(projectRoot = process.cwd()) {
  const configTs = path.join(projectRoot, "capacitor.config.ts");
  const configJs = path.join(projectRoot, "capacitor.config.js");
  const configJson = path.join(projectRoot, "capacitor.config.json");
  // capacitor.config.ts (most common in Capacitor React apps)
  if (fs.existsSync(configTs)) {
    const content = fs.readFileSync(configTs, "utf-8");
    const match = content.match(/appId:\s*['"`](.*?)['"`]/);
    if (!match) {
      console.error("❌ Could not extract appId from capacitor.config.ts");
      process.exit(1);
    }
    return match[1];
  }

  // capacitor.config.js
  if (fs.existsSync(configJs)) {
    const content = fs.readFileSync(configJs, "utf8");
    const match = content.match(/appId\s*:\s*['"]([^'"]+)['"]/);
    if (match) return match[1];
  }

  if (fs.existsSync(configJson)) {
    try {
      const config = JSON.parse(fs.readFileSync(configJson, "utf-8"));
      if (config.appId) return String(config.appId);
    } catch (err) {
      console.error(`❌ Failed to parse capacitor.config.json: ${err.message}`);
      process.exit(1);
    }
  }

  console.error(
    "❌ capacitor.config.ts / capacitor.config.json not found! Run this command from your app root.",
  );
  process.exit(1);
}

/**
 * The APK flow needs an actual native Android project - fail early with a
 * helpful message instead of a confusing gradle/cap error.
 * `gradlew.bat` is also accepted so Windows checkouts work.
 */
function getAndroidDir(projectRoot = getProjectRoot()) {
  const androidDir = path.join(projectRoot, "android");
  const hasGradleWrapper =
    fs.existsSync(path.join(androidDir, "gradlew")) ||
    fs.existsSync(path.join(androidDir, "gradlew.bat"));
  if (!hasGradleWrapper) {
    console.error(
      `❌ No Android platform found at ${androidDir}.\n` +
        `   Run "npx cap add android" (or build your app) once from ${projectRoot} before releasing an APK.`,
    );
    process.exit(1);
  }
  return androidDir;
}

function getAppVersion(projectRoot = process.cwd()) {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error("❌ package.json not found!");
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version || "0.0.0";
}

// ---------------------------------------------------------------------------
// Gradle parsing (same approach as bundle.cjs - only Groovy build.gradle files,
// as used by Capacitor projects)
// ---------------------------------------------------------------------------

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

function readIntegerGradleValue(blockContent, key) {
  const match = blockContent.match(new RegExp(`\\b${key}\\b\\s+([0-9]+)`));
  return match ? Number(match[1]) : null;
}

function getAndroidGradlePath(projectRoot = getProjectRoot()) {
  return path.join(projectRoot, "android", "app", "build.gradle");
}

function getAndroidProjectMetadata(projectRoot = getProjectRoot()) {
  const gradlePath = getAndroidGradlePath(projectRoot);
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

  const defaultContent = defaultConfigBlock?.content ?? "";
  const defaultAppId =
    readQuotedGradleValue(defaultContent, "applicationId") ??
    getAppId(projectRoot);
  const defaultVersion =
    readQuotedGradleValue(defaultContent, "versionName") ??
    getAppVersion(projectRoot);
  const defaultVersionCode =
    readIntegerGradleValue(defaultContent, "versionCode") ?? 1;

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
    const flavorVersionCode = readIntegerGradleValue(content, "versionCode");

    return {
      name,
      appId: flavorAppId ?? `${defaultAppId}${flavorAppIdSuffix ?? ""}`,
      version: flavorVersion ?? `${defaultVersion}${flavorVersionSuffix ?? ""}`,
      versionCode: flavorVersionCode ?? defaultVersionCode,
    };
  });

  return {
    defaultConfig: {
      name: "default",
      label: "Default",
      appId: defaultAppId,
      version: defaultVersion,
      versionCode: defaultVersionCode,
    },
    flavors,
  };
}

/** Same flavor-selection UX as the bundle flow, extended with versionCode. */
async function getAndroidVariantSelection(
  projectRoot,
  preselectedFlavor,
  assumeYes = false,
) {
  const metadata = getAndroidProjectMetadata(projectRoot);
  if (!metadata) {
    console.warn(
      "⚠️ Falling back to manual variant entry (build.gradle unavailable).",
    );
    return {
      name: "default",
      label: "Default",
      appId: getAppId(projectRoot),
      version: getAppVersion(projectRoot),
      versionCode: null,
    };
  }

  if (!metadata.flavors.length) {
    console.log(
      `📦 No product flavors found - using default config (${metadata.defaultConfig.appId} / ${metadata.defaultConfig.version})`,
    );
    return metadata.defaultConfig;
  }

  // --flavor <name> (or APPUPDATE_ANDROID_FLAVOR): use it directly, fail fast
  // when unknown.
  const wantedFlavor =
    preselectedFlavor || process.env.APPUPDATE_ANDROID_FLAVOR;
  if (wantedFlavor) {
    const wanted = String(wantedFlavor).toLowerCase();
    const match =
      metadata.flavors.find((f) => f.name.toLowerCase() === wanted) ||
      (wanted === "default" ? metadata.defaultConfig : null);
    if (!match) {
      console.error(
        `❌ Unknown flavor "${wantedFlavor}". Available: default, ${metadata.flavors.map((f) => f.name).join(", ")}`,
      );
      process.exit(1);
    }
    return match.label ? match : { ...match, label: match.name };
  }

  // --yes: never prompt. Use the first declared flavor (a flavored project has
  // no plain `assembleRelease` task, so "default" is not a valid fallback).
  if (assumeYes) {
    const flavor = metadata.flavors[0];
    console.log(
      `📦 Using Android flavor "${flavor.name}" (--yes). ` +
        `Pass --flavor <name> or set APPUPDATE_ANDROID_FLAVOR to change it. ` +
        `Available: ${metadata.flavors.map((f) => f.name).join(", ")}`,
    );
    return { ...flavor, label: flavor.name };
  }

  let selectedFlavor;
  let isFlavorConfirmed = false;

  while (!isFlavorConfirmed) {
    selectedFlavor = await select({
      message: "Select Android flavor / variant:",
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
      message: `Continue with Android variant ${selectedFlavor.label ?? selectedFlavor.name}?`,
      default: true,
    });
  }

  return selectedFlavor;
}

// ---------------------------------------------------------------------------
// Keystore resolution (fully dynamic - nothing hardcoded)
//
// Priority:
//   1. Environment variables (APPUPDATE_KEYSTORE_PATH / _PASSWORD / _ALIAS / _KEY_PASSWORD)
//   2. android/keystore.properties (or APPUPDATE_KEYSTORE_PROPERTIES_FILE) with
//      common keys: storeFile/storePassword/keyAlias/keyPassword or
//      KEYSTORE_FILE/KEYSTORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD etc.
//   3. Scan android/ for *.jks / *.keystore files and prompt for credentials
// ---------------------------------------------------------------------------

function readPropertiesFile(filePath) {
  const props = {};
  if (!fs.existsSync(filePath)) return props;

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) props[key] = value;
  }
  return props;
}

function findKeystorePropertiesFile(projectRoot) {
  const custom = APPUPDATE_KEYSTORE_PROPERTIES_FILE
    ? path.isAbsolute(APPUPDATE_KEYSTORE_PROPERTIES_FILE)
      ? APPUPDATE_KEYSTORE_PROPERTIES_FILE
      : path.join(projectRoot, APPUPDATE_KEYSTORE_PROPERTIES_FILE)
    : null;
  const candidates = [
    custom,
    path.join(projectRoot, "android", "keystore.properties"),
    path.join(projectRoot, "android", "keystore.props"),
    path.join(projectRoot, "android", "signing.properties"),
    path.join(projectRoot, "android", "app", "keystore.properties"),
    path.join(projectRoot, "keystore.properties"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Known key names used in keystore.properties files, grouped by role. */
const KEYSTORE_PROPERTY_KEYS = {
  storeFile: [
    "storeFile",
    "store",
    "KEYSTORE_FILE",
    "KEYSTORE_PATH",
    "keystore",
    "keystoreFile",
  ],
  storePassword: [
    "storePassword",
    "KEYSTORE_PASSWORD",
    "keystorePassword",
    "KEY_STORE_PASSWORD",
  ],
  keyAlias: ["keyAlias", "KEY_ALIAS", "alias", "keyStoreAlias"],
  keyPassword: ["keyPassword", "KEY_PASSWORD", "keyPass", "keyStorePassword"],
};

function pickProperty(props, keys) {
  for (const key of keys) {
    if (props[key]) return props[key];
  }
  return null;
}

function resolveKeystoreStoreFile(rawPath, projectRoot) {
  if (!rawPath) return null;

  const candidates = [];
  if (path.isAbsolute(rawPath)) {
    candidates.push(rawPath);
  } else {
    // Relative paths can be relative to the properties file location, the
    // android/ dir or the project root (or an android/ prefix inside them).
    candidates.push(
      path.join(projectRoot, "android", rawPath),
      path.join(projectRoot, "android", "app", rawPath),
      path.join(projectRoot, rawPath),
      path.join(projectRoot, rawPath.replace(/^android\//, "")),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function scanForKeystores(projectRoot) {
  const results = [];
  const androidDir = path.join(projectRoot, "android");
  const scanDirs = [androidDir, projectRoot];

  function scan(dir, depth) {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        dir === projectRoot &&
        (entry === "node_modules" || entry.startsWith("."))
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Skip common build dirs - keystores are never inside build outputs.
        if (
          ["build", "outputs", "intermediates", "gradle", ".gradle"].includes(
            entry,
          )
        ) {
          continue;
        }
        scan(fullPath, depth + 1);
      } else if (/\.(jks|keystore)$/i.test(entry)) {
        results.push(fullPath);
      }
    }
  }

  scanDirs.forEach((dir) => scan(dir, 0));
  return [...new Set(results)];
}

/**
 * AGP only applies the injected signing override when *all four* values are
 * present (see Android Gradle Plugin's SigningOptions.readSigningOptions).
 * Without them the build silently falls back to the project's own signing
 * config (often `signingConfigs.debug`), which produces a debug-signed APK that
 * cannot be installed over an already released app. Keep the config complete
 * and warn loudly when it is not.
 */
function normalizeKeystoreConfig(config) {
  const normalized = {
    storeFile: config.storeFile ?? null,
    storePassword: config.storePassword ?? null,
    keyAlias: config.keyAlias ?? null,
    keyPassword: config.keyPassword ?? config.storePassword ?? null,
  };

  const missing = ["storeFile", "storePassword", "keyAlias"].filter(
    (key) => !normalized[key],
  );
  normalized.complete = missing.length === 0;

  if (!normalized.complete) {
    console.warn(
      `⚠️ Incomplete keystore configuration (missing: ${missing.join(", ")}).\n` +
        "   AGP will ignore the signing override and use your project's default " +
        "signing config (debug keystore in most Capacitor projects).",
    );
  }

  return normalized;
}

/**
 * Resolves the signing config dynamically. Returns null when nothing can be
 * found (the caller then builds unsigned / with the project's own config).
 */
async function resolveKeystoreConfig(projectRoot, assumeYes = false) {
  // 1) Environment variables
  if (APPUPDATE_KEYSTORE_PATH) {
    const storeFile = path.isAbsolute(APPUPDATE_KEYSTORE_PATH)
      ? APPUPDATE_KEYSTORE_PATH
      : path.join(projectRoot, APPUPDATE_KEYSTORE_PATH);
    if (fs.existsSync(storeFile)) {
      const alias = APPUPDATE_KEYSTORE_ALIAS;
      if (!alias) {
        console.warn(
          "⚠️ APPUPDATE_KEYSTORE_ALIAS not set - trying to read it from gradle or prompting.",
        );
      }
      console.log(`🔑 Using keystore from environment: ${storeFile}`);
      return normalizeKeystoreConfig({
        storeFile,
        storePassword: APPUPDATE_KEYSTORE_PASSWORD,
        keyAlias: alias,
        keyPassword: APPUPDATE_KEY_PASSWORD || APPUPDATE_KEYSTORE_PASSWORD,
      });
    }
    console.warn(
      `⚠️ APPUPDATE_KEYSTORE_PATH set but file not found: ${storeFile} - falling back.`,
    );
  }

  // 2) keystore.properties style file
  const propsFile = findKeystorePropertiesFile(projectRoot);
  if (propsFile) {
    const props = readPropertiesFile(propsFile);
    const rawStoreFile = pickProperty(props, KEYSTORE_PROPERTY_KEYS.storeFile);
    const storeFile = resolveKeystoreStoreFile(rawStoreFile, projectRoot);
    if (storeFile) {
      console.log(
        `🔑 Using keystore from ${path.relative(projectRoot, propsFile)}: ${storeFile}`,
      );
      const storePassword = pickProperty(
        props,
        KEYSTORE_PROPERTY_KEYS.storePassword,
      );
      const keyAlias = pickProperty(props, KEYSTORE_PROPERTY_KEYS.keyAlias);
      return normalizeKeystoreConfig({
        storeFile,
        storePassword,
        keyAlias,
        keyPassword:
          pickProperty(props, KEYSTORE_PROPERTY_KEYS.keyPassword) ??
          storePassword,
      });
    }
    console.warn(
      `⚠️ Found ${path.relative(projectRoot, propsFile)} but could not resolve its keystore file - falling back.`,
    );
  }

  // 3) Scan for keystore files and prompt for the credentials. In --yes mode
  // there is nobody to answer, so only env/properties can provide signing.
  if (assumeYes) {
    console.warn(
      "⚠️ --yes: no signing config found via APPUPDATE_KEYSTORE_* env vars or " +
        "android/keystore.properties, and credentials cannot be prompted for.\n" +
        "   Gradle will fall back to your project's own signingConfig (release " +
        "APKs come out unsigned when the project has none).",
    );
    return null;
  }

  const keystores = scanForKeystores(projectRoot);
  if (!keystores.length) {
    console.warn(
      "⚠️ No keystore (.jks/.keystore) found in the android directory. " +
        "Set APPUPDATE_KEYSTORE_* env vars or add android/keystore.properties to sign the release build.",
    );
    return null;
  }

  const storeFile =
    keystores.length === 1
      ? keystores[0]
      : await select({
          message: "Multiple keystores found. Select one:",
          choices: keystores.map((file) => ({ name: file, value: file })),
        });

  console.log(`🔑 Found keystore: ${storeFile}`);
  const storePassword = await input({
    message: "Enter keystore (store) password:",
    type: "password",
    validate: (val) => (val.trim() ? true : "Password required"),
  });
  const keyAlias = await input({
    message: "Enter key alias:",
    validate: (val) => (val.trim() ? true : "Key alias required"),
  });
  const keyPassword = await input({
    message: "Enter key password (Enter to reuse store password):",
    type: "password",
  });

  return normalizeKeystoreConfig({
    storeFile,
    storePassword,
    keyAlias,
    keyPassword: keyPassword || storePassword,
  });
}

// ---------------------------------------------------------------------------
// JDK resolution (Gradle needs Java 21+ for Capacitor 7)
// ---------------------------------------------------------------------------

/**
 * Capacitor 7 ships `capacitor-android` with `sourceCompatibility 21`. If the
 * shell's JAVA_HOME points at an older JDK the web build + `cap sync` succeed
 * and then Gradle dies with a cryptic:
 *     > Task :capacitor-android:compileReleaseJavaWithJavac FAILED
 *     > error: invalid source release: 21
 * Resolving a suitable JDK here makes `appupdate-apk` build identically on
 * every machine, no per-project `export JAVA_HOME=...` scripts needed.
 */
const MIN_GRADLE_JAVA = 21;

/** Major version of a JDK home, read from its `release` file (falls back to `java -version`). */
function getJavaMajorVersion(javaHome) {
  if (!javaHome) return null;
  try {
    const releaseFile = path.join(javaHome, "release");
    if (fs.existsSync(releaseFile)) {
      const match = fs
        .readFileSync(releaseFile, "utf8")
        .match(/JAVA_VERSION="?(\d+)/i);
      if (match) return Number(match[1]);
    }
  } catch {
    // fall through to the java binary
  }
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync(
      "/bin/sh",
      ["-c", `"${path.join(javaHome, "bin", "java")}" -version 2>&1`],
      { encoding: "utf8" },
    );
    const match = String(out).match(/version "(\d+)/);
    if (match) return Number(match[1]);
  } catch {
    // not a usable JDK - ignore
  }
  return null;
}

/** Best-effort list of JDK homes to consider, in preference order. */
function collectJavaHomeCandidates() {
  const candidates = [];
  const push = (dir) => {
    if (dir && fs.existsSync(dir) && !candidates.includes(dir))
      candidates.push(dir);
  };

  push(process.env.APPUPDATE_JAVA_HOME);
  push(process.env.JAVA_HOME);

  if (process.platform === "darwin") {
    // Prefer the lowest JDK that satisfies the requirement (most stable with AGP 8.x).
    for (const version of [MIN_GRADLE_JAVA, 22, 23, 24]) {
      try {
        const home = execFileSync(
          "/usr/libexec/java_home",
          ["-v", String(version)],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        push(home);
      } catch {
        // no JDK for this version
      }
    }
    push("/Applications/Android Studio.app/Contents/jbr/Contents/Home");
  }

  for (const base of [
    `/opt/homebrew/opt/openjdk@${MIN_GRADLE_JAVA}/libexec/openjdk.jdk/Contents/Home`,
    `/usr/local/opt/openjdk@${MIN_GRADLE_JAVA}/libexec/openjdk.jdk/Contents/Home`,
  ]) {
    push(base);
  }

  // Scan the standard JDK install directories (macOS + Linux layouts).
  const vmRoots = [
    "/Library/Java/JavaVirtualMachines",
    process.env.HOME
      ? path.join(process.env.HOME, "Library/Java/JavaVirtualMachines")
      : null,
    "/usr/lib/jvm",
  ].filter(Boolean);

  for (const root of vmRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        push(path.join(root, entry, "Contents", "Home")); // macOS
        push(path.join(root, entry)); // Linux
      }
    } catch {
      // ignore unreadable dirs
    }
  }

  return candidates;
}

/**
 * Picks the JDK Gradle must use. An explicit `APPUPDATE_JAVA_HOME` always wins;
 * otherwise the current JAVA_HOME is kept when it already satisfies the
 * requirement, and only then do we auto-select from the discovered JDKs.
 */
function resolveJavaHome() {
  if (process.env.APPUPDATE_JAVA_HOME) {
    const major = getJavaMajorVersion(process.env.APPUPDATE_JAVA_HOME);
    return { home: process.env.APPUPDATE_JAVA_HOME, major, auto: false };
  }

  const currentMajor = getJavaMajorVersion(process.env.JAVA_HOME);
  if (
    process.env.JAVA_HOME &&
    currentMajor != null &&
    currentMajor >= MIN_GRADLE_JAVA
  ) {
    return { home: process.env.JAVA_HOME, major: currentMajor, auto: false };
  }

  const suitable = collectJavaHomeCandidates()
    .map((home) => ({ home, major: getJavaMajorVersion(home) }))
    .filter((c) => c.major != null && c.major >= MIN_GRADLE_JAVA)
    .sort((a, b) => a.major - b.major);

  if (suitable.length) return { ...suitable[0], auto: true };

  return {
    home: null,
    major: currentMajor,
    auto: false,
    error:
      `No JDK ${MIN_GRADLE_JAVA}+ found - Capacitor 7 requires it to build the ` +
      `Android release APK.\n` +
      `   Detected JAVA_HOME: ${process.env.JAVA_HOME || "(unset)"} ` +
      `(JDK ${currentMajor ?? "unknown"}).\n` +
      `   Install a JDK ${MIN_GRADLE_JAVA} (or set APPUPDATE_JAVA_HOME=/path/to/jdk-21) and re-run.`,
  };
}

/**
 * Builds the release APK via the gradle wrapper.
 *
 * Signing is injected through AGP's standard "-Pandroid.injected.signing.*"
 * properties, which work with any project without modifying build.gradle and
 * take precedence over the build type's own signingConfig.
 *
 * NOTE: AGP has no "android.injected.version.*" support, so the version
 * name/code always come from android/app/build.gradle. That is why the built
 * APK is verified afterwards (see readApkOutputMetadata) and the *actual* APK
 * values are what gets registered on the update server.
 */
function buildReleaseApk({ variant, keystore, projectRoot }) {
  const androidDir = getAndroidDir(projectRoot || getProjectRoot());
  const isWindows = process.platform === "win32";
  const gradlewPath = path.join(
    androidDir,
    isWindows ? "gradlew.bat" : "gradlew",
  );

  const taskName = `assemble${variant}Release`;
  console.log(`\n🏗️  Building release APK: ${taskName}`);

  const java = resolveJavaHome();
  if (!java.home) {
    console.error(`❌ ${java.error}`);
    process.exit(1);
  }
  console.log(
    `☕ Gradle JDK ${java.major}: ${java.home}${java.auto ? "  (auto-selected)" : ""}`,
  );

  const args = ["-p", androidDir, taskName];

  if (keystore?.complete) {
    args.push(
      `-Pandroid.injected.signing.store.file=${keystore.storeFile}`,
      `-Pandroid.injected.signing.store.password=${keystore.storePassword}`,
      `-Pandroid.injected.signing.key.alias=${keystore.keyAlias}`,
      `-Pandroid.injected.signing.key.password=${keystore.keyPassword ?? keystore.storePassword}`,
    );
    console.log(
      `🔏 Signing with the resolved keystore (${path.basename(keystore.storeFile)}, alias "${keystore.keyAlias}").`,
    );
  } else {
    console.log(
      "⚠️ No complete signing config resolved - the APK will be signed with your project's " +
        "default signing config (usually the debug keystore).\n" +
        "   An APK signed with a different key than the installed app CANNOT be installed over it.",
    );
  }

  runCommand(gradlewPath, args, {
    cwd: androidDir,
    shell: isWindows,
    env: { ...process.env, JAVA_HOME: java.home },
  });
}

// ---------------------------------------------------------------------------
// APK output discovery & S3 upload
// ---------------------------------------------------------------------------

/** True when the path points at a debuggable APK output. */
function isDebugApkPath(p) {
  const n = String(p).toLowerCase().replace(/\\/g, "/");
  return /(^|\/)debug(\/|-|$)/.test(n) || /-debug\.apk$/.test(n);
}

/** True when the path points at AGP's "unsigned" APK (cannot be installed). */
function isUnsignedApkPath(p) {
  return /-unsigned(-aligned)?\.apk$/.test(String(p).toLowerCase());
}

/**
 * Finds APKs under android/app/build/outputs/apk.
 * - build mode: only APKs from this run (startTime) + prefer the release
 *   output of the selected variant (release preferred, debug still visible).
 * - upload mode: lists EVERYTHING (release + debug + all flavors) so any
 *   previously built APK can be picked. Debug APKs are labelled + gated.
 */
function findBuiltApk({
  variantName,
  projectRoot,
  startTime,
  uploadMode,
  flavorFilter,
}) {
  const outputsRoot = path.join(
    projectRoot,
    "android",
    "app",
    "build",
    "outputs",
    "apk",
  );
  if (!fs.existsSync(outputsRoot)) {
    console.warn(`⚠️ APK outputs directory not found: ${outputsRoot}`);
    return [];
  }

  const isFlavored = !!variantName && variantName.toLowerCase() !== "default";
  const flavorDir = isFlavored ? variantName.toLowerCase() : null;
  // `--flavor <name>` in upload mode narrows the picker to a single flavor dir.
  const uploadFlavorDir =
    uploadMode && flavorFilter ? flavorFilter.toLowerCase() : null;
  const candidates = [];

  function scoreApk(fullPath) {
    const normalized = fullPath.toLowerCase().replace(/\\/g, "/");
    const isDebug = isDebugApkPath(normalized);
    const inRelease =
      /(^|\/)release(\/|$)/.test(normalized) ||
      /-release\.apk$/.test(normalized);
    const isUnsigned = isUnsignedApkPath(normalized);
    let base = 0;
    if (flavorDir) {
      if (normalized.includes(`/${flavorDir}/release/`)) base = 4;
      else if (normalized.includes(`/${flavorDir}/`)) base = 3;
      else base = inRelease ? 1 : 0;
    } else {
      if (/outputs\/apk\/release\//.test(normalized)) base = 4;
      else base = inRelease ? 1 : 0;
    }
    // In upload mode keep debug/unsigned APKs selectable but rank them last.
    // In build mode release stays on top; the others are only fallbacks.
    if (isDebug) base -= 2;
    if (isUnsigned) base -= 4;
    return base;
  }

  function collect(dir, depth) {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        collect(fullPath, depth + 1);
      } else if (entry.toLowerCase().endsWith(".apk")) {
        // Build mode: ignore stale builds from before this run started.
        // Upload mode: list everything (no startTime passed).
        if (startTime && stat.mtime.getTime() < startTime - 1000) continue;
        const full = fullPath.toLowerCase().replace(/\\/g, "/");
        // `--flavor <name>` in upload mode narrows the picker to that flavor.
        if (uploadFlavorDir && !full.includes(`/${uploadFlavorDir}/`)) continue;
        candidates.push({
          path: fullPath,
          mtime: stat.mtime.getTime(),
          score: scoreApk(fullPath),
          isDebug: isDebugApkPath(full),
          isUnsigned: isUnsignedApkPath(full),
        });
      }
    }
  }

  collect(outputsRoot, 0);

  const sorted = candidates.sort(
    (a, b) => b.score - a.score || b.mtime - a.mtime,
  );

  // Build mode: only well-matched, installable outputs are auto-picked (debug
  // is kept as a fallback, unsigned APKs never are). Upload mode returns the
  // full list so release + debug + every flavor is selectable.
  if (!uploadMode) {
    const usable = sorted.filter((c) => !c.isUnsigned);
    // Prefer the release output of the requested variant; only fall back to a
    // debug APK when the release build really produced nothing (so the caller
    // is never asked to choose between release and debug).
    const releaseStrong = usable.filter((c) => c.score > 0 && !c.isDebug);
    if (releaseStrong.length) return releaseStrong.map((c) => c.path);
    const anyStrong = usable.filter((c) => c.score > 0);
    if (anyStrong.length) return anyStrong.map((c) => c.path);
    if (usable.length) return usable.map((c) => c.path);
    if (sorted.length) {
      console.warn(
        "⚠️ Only unsigned release APKs were produced. Gradle could not sign " +
          "them - check the keystore configuration (APPUPDATE_KEYSTORE_* or " +
          "android/keystore.properties).",
      );
    }
    return sorted.map((c) => c.path);
  }
  return sorted;
}

/**
 * AGP writes an `output-metadata.json` next to every APK it produces, including
 * the applicationId / versionCode / versionName that are *actually inside* the
 * APK. Since AGP has no version-injection support, this is the only reliable
 * way to know what was just built - and it is what we register on the server so
 * the app's update check can never loop on a version that does not exist.
 */
function readApkOutputMetadata(apkPath) {
  const metadataPath = path.join(path.dirname(apkPath), "output-metadata.json");
  if (!fs.existsSync(metadataPath)) return null;

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const elements = Array.isArray(metadata.elements) ? metadata.elements : [];
    const apkName = path.basename(apkPath);
    const element =
      elements.find(
        (entry) => path.basename(entry.outputFile ?? "") === apkName,
      ) ?? (elements.length === 1 ? elements[0] : null);

    if (!element) return null;

    return {
      metadataPath,
      applicationId: metadata.applicationId ?? null,
      versionCode:
        element.versionCode != null ? Number(element.versionCode) : null,
      versionName: element.versionName ?? null,
    };
  } catch (err) {
    console.warn(`⚠️ Could not read ${metadataPath}: ${err.message}`);
    return null;
  }
}

/**
 * Returns the metadata that will be registered for the APK, preferring the
 * values that are really inside the built APK and asking for confirmation when
 * they differ from what was entered at the prompts.
 */
async function resolveRegistrationMetadata({
  apkFile,
  entered,
  assumeYes = false,
}) {
  const built = readApkOutputMetadata(apkFile);

  if (!built) {
    console.warn(
      "⚠️ output-metadata.json was not found next to the APK - the version inside the APK could not be verified.\n" +
        "   Registering the values you entered.",
    );
    return entered;
  }

  const resolved = {
    packageName: built.applicationId || entered.packageName,
    versionName: built.versionName || entered.versionName,
    versionCode:
      built.versionCode != null ? built.versionCode : entered.versionCode,
  };

  const mismatches = [];
  if (built.applicationId && built.applicationId !== entered.packageName) {
    mismatches.push(
      `package name: entered "${entered.packageName}" vs APK "${built.applicationId}"`,
    );
  }
  if (built.versionName && built.versionName !== entered.versionName) {
    mismatches.push(
      `version name: entered "${entered.versionName}" vs APK "${built.versionName}"`,
    );
  }
  if (
    built.versionCode != null &&
    Number(entered.versionCode) !== built.versionCode
  ) {
    mismatches.push(
      `version code: entered "${entered.versionCode}" vs APK "${built.versionCode}"`,
    );
  }

  if (!mismatches.length) {
    console.log(
      `✅ APK verified: ${resolved.packageName} v${resolved.versionName} (versionCode ${resolved.versionCode}).`,
    );
    return resolved;
  }

  console.warn(
    "\n⚠️ The built APK does not match the values you entered:\n" +
      mismatches.map((entry) => `   - ${entry}`).join("\n"),
  );
  console.warn(
    "\n   The registered metadata must match the APK, otherwise devices will keep\n" +
      "   seeing an update that can never be installed (the version inside the APK\n" +
      "   is what the app compares against).\n" +
      "   Bump versionName/versionCode in android/app/build.gradle and re-run if you\n" +
      "   wanted to publish a new version.\n",
  );

  // The values inside the APK always win - they are what the app compares
  // against. --yes confirms that automatically (no prompt).
  if (assumeYes) {
    console.warn("   --yes: registering the APK's real values.");
    return resolved;
  }

  const useBuiltValues = await confirm({
    message: `Register the APK's real values (${resolved.packageName} / ${resolved.versionName} / versionCode ${resolved.versionCode})?`,
    default: true,
  });

  if (!useBuiltValues) {
    console.error(
      "❌ Aborted. Update versionName/versionCode in android/app/build.gradle, rebuild and run the command again.",
    );
    process.exit(1);
  }

  return resolved;
}

async function uploadFileToS3(filePath, bucketName, folder, contentType) {
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
      ContentType: contentType,
      ACL: "public-read",
    });

    await getS3Client().send(command);

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

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function getCommonConfig(cli) {
  console.log(`\n⚙️  Enter common configuration for the app\n`);

  const API_TOKEN =
    cli.apiToken ||
    process.env.APPUPDATE_API_TOKEN ||
    (await input({
      message: `Enter API Token:`,
      validate: (val) => (val.trim() ? true : "API Token required"),
    }));

  const PROJECT_ID =
    cli.projectId ||
    process.env.APPUPDATE_PROJECT_ID ||
    (await input({
      message: `Enter Project ID:`,
      validate: (val) => (val.trim() ? true : "Project ID required"),
    }));

  // The web-build suffix already tells us the target: live/prod -> production,
  // everything else (dev, dev:test, local-tablet, ...) -> development.
  const defaultEnvironment = /^(live|prod|production)$/i.test(
    cli.envSuffix || "",
  )
    ? "production"
    : "development";

  // --yes accepts the detected defaults without any confirmation prompts.
  if (cli.assumeYes) {
    return { API_TOKEN, PROJECT_ID, ENVIRONMENT: defaultEnvironment };
  }

  let ENVIRONMENT;
  let isEnvironmentConfirmed = false;

  while (!isEnvironmentConfirmed) {
    ENVIRONMENT = await select({
      message: `Select Environment:`,
      choices: [
        { name: "development", value: "development" },
        { name: "production", value: "production" },
      ],
      default: defaultEnvironment,
    });

    isEnvironmentConfirmed = await confirm({
      message: `Continue with ${ENVIRONMENT} environment?`,
      default: true,
    });
  }

  return { API_TOKEN, PROJECT_ID, ENVIRONMENT };
}

function printUsage() {
  console.log(
    [
      "",
      "3rdDigital AppUpdate - Android in-app APK release CLI",
      "",
      "Usage:",
      "  npx appupdate-apk                        # build with `npm run build`, then upload",
      "  npx appupdate-apk <suffix>               # build with `npm run build:<suffix>`",
      "                                           #   dev | live | prod | dev:test | local-tablet",
      "  npx appupdate-apk upload [env]           # skip building, pick ANY existing APK (release + debug)",
      "  npx appupdate-apk --apk <path>           # upload this exact APK (skips scan)",
      "  npx appupdate-apk --flavor <name>        # build / look for this Android product flavor",
      "  npx appupdate-apk --env <name>           # web-build suffix override",
      "  npx appupdate-apk --project <id> --api-token <t> [--force|--no-force] [--yes]",
      "",
      "Debug-APK guard:",
      "  Debug (debuggable) APKs are labelled [DEBUG] in the picker and are",
      "  blocked for production unless you repeat with --allow-debug-apk.",
      "  Release APKs receive only other release APKs as updates (see docs).",
      "",
      "Required .env (in your app root):",
      "  APPUPDATE_BASE_URL, APPUPDATE_API_KEY, APPUPDATE_AWS_REGION,",
      "  APPUPDATE_AWS_ACCESS_KEY_ID, APPUPDATE_AWS_SECRET_ACCESS_KEY,",
      "  APPUPDATE_AWS_BUCKET_NAME",
      "",
      "Optional release signing (else android/keystore.properties or a *.jks scan):",
      "  APPUPDATE_KEYSTORE_PATH, APPUPDATE_KEYSTORE_PASSWORD,",
      "  APPUPDATE_KEYSTORE_ALIAS, APPUPDATE_KEY_PASSWORD",
      "",
      "Optional prompt-skipping / JDK override:",
      "  APPUPDATE_API_TOKEN, APPUPDATE_PROJECT_ID, APPUPDATE_JAVA_HOME",
      "",
    ].join("\n"),
  );
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const startTime = Date.now();

  if (cli.help) {
    printUsage();
    return;
  }

  validateEnvConfig();

  const mode = cli.mode;
  const envSuffix = cli.envSuffix;

  console.log(
    mode === "upload"
      ? "\n🚀 3rdDigital AppUpdate - APK upload (no build)\n"
      : "\n🚀 3rdDigital AppUpdate - APK release build & upload\n",
  );

  const projectRoot = getProjectRoot();
  const config = await getCommonConfig(cli);

  // 1) Android variant selection. Upload mode rebuilds nothing, so a flavor is
  // irrelevant there - the APK itself carries the package/version (verified
  // from its own output-metadata.json). Never prompt here, and never hard-fail
  // when capacitor.config / build.gradle extras are missing.
  let variant;
  if (mode === "upload" && !cli.flavor) {
    const metadata = getAndroidProjectMetadata(projectRoot);
    variant = metadata?.defaultConfig ?? {
      name: "default",
      label: "Default",
      appId: "",
      version: "",
      versionCode: null,
    };
  } else {
    variant = await getAndroidVariantSelection(
      projectRoot,
      cli.flavor,
      cli.assumeYes,
    );
  }
  if (variant.label && variant.appId) {
    console.log(
      `📦 Selected Android variant: ${variant.label} (${variant.appId})`,
    );
  }

  // 2) Versions are auto-detected (gradle defaultConfig / flavor /
  // package.json) and only confirmed - never typed blind. --yes accepts all.
  const detectedVersionName = String(
    variant.version ?? getAppVersion(projectRoot) ?? "",
  );
  const detectedVersionCode =
    variant.versionCode != null ? String(variant.versionCode) : "";
  console.log(
    `\n📌 Detected app version: ${detectedVersionName || "(unknown)"} ` +
      `(versionCode ${detectedVersionCode || "unknown"}) ` +
      `for ${variant.appId} [${variant.label || variant.name}]`,
  );
  if (!cli.assumeYes) {
    const ok = await confirm({
      message: `Continue with version ${detectedVersionName} (code ${detectedVersionCode})?`,
      default: true,
    });
    if (!ok) {
      console.error(
        "❌ Aborted. Bump versionName/versionCode in android/app/build.gradle (or package.json) and re-run.",
      );
      process.exit(1);
    }
  }
  // AGP writes versionName/versionCode from android/app/build.gradle, so these
  // are only a fallback for when the APK metadata cannot be read. --yes keeps
  // the detected values without prompting.
  let versionName = detectedVersionName;
  let versionCode = detectedVersionCode;
  if (!cli.assumeYes) {
    versionName = await input({
      message: "Version Name (press Enter to keep detected):",
      default: detectedVersionName,
      validate: (val) => (val.trim() ? true : "Version name required"),
    });

    versionCode = await input({
      message: "Version Code (press Enter to keep detected):",
      default: detectedVersionCode,
      validate: (val) =>
        /^[0-9]+$/.test(val.trim()) ? true : "Version code must be a number",
    });
  }

  const forceUpdate =
    cli.forceUpdate !== undefined
      ? cli.forceUpdate
      : cli.assumeYes
        ? false
        : await confirm({
            message: "Force Update?",
            default: false,
          });

  // In "upload" mode we reuse an existing APK, so the "built after this run
  // started" filter must be disabled.
  const buildStartTime = mode === "build" ? startTime : undefined;

  // 3) Web build + cap sync + signed release APK (skipped in "upload" mode)
  const gradleVariant =
    variant.name && variant.name !== "default"
      ? variant.name.charAt(0).toUpperCase() + variant.name.slice(1)
      : "";
  if (mode === "build") {
    // Validates the script exists first (clear error instead of silent fail).
    const buildCommand = resolveWebBuildCommand(projectRoot, envSuffix);
    run(buildCommand, { cwd: projectRoot });
    run("npx cap sync android", { cwd: projectRoot });

    // 4) Keystore resolution + release APK build
    const keystore = await resolveKeystoreConfig(projectRoot, cli.assumeYes);
    buildReleaseApk({ variant: gradleVariant, keystore, projectRoot });
  }

  // 5) Locate the APK:
  //  - build mode: fresh outputs for this variant/run
  //  - upload mode: EVERY existing APK (release + debug + all flavors)
  //  - --apk <path>: skip the scan entirely
  let apkFile = null;
  if (cli.apkPath) {
    const resolved = path.resolve(projectRoot, cli.apkPath.trim());
    if (!fs.existsSync(resolved)) {
      console.error(`❌ APK not found: ${resolved}`);
      process.exit(1);
    }
    apkFile = resolved;
    console.log(`📱 APK (from --apk): ${apkFile}`);
  } else {
    const apkEntries = findBuiltApk({
      variantName: gradleVariant || "default",
      projectRoot,
      startTime: buildStartTime,
      uploadMode: mode === "upload",
      flavorFilter: cli.flavor,
    });

    if (!apkEntries.length) {
      if (mode === "upload") {
        apkFile = await input({
          message:
            "No APKs found under android/app/build/outputs/apk. Enter the path to the APK file:",
          validate: (val) =>
            fs.existsSync(val.trim()) ? true : "APK file not found",
        });
      } else {
        console.error(
          "❌ No release APK was produced. Check the gradle output above.",
        );
        process.exit(1);
      }
    } else if (apkEntries.length === 1) {
      const only =
        typeof apkEntries[0] === "string"
          ? { path: apkEntries[0] }
          : apkEntries[0];
      apkFile = only.path;
      console.log(`📱 APK: ${apkFile}`);
    } else {
      const picked = await select({
        message:
          mode === "upload"
            ? "Multiple APKs found (release + debug). Select one:"
            : "Multiple APKs were produced. Select one:",
        choices: apkEntries.slice(0, 20).map((entry) => {
          const p = typeof entry === "string" ? entry : entry.path;
          const debug = isDebugApkPath(p);
          const unsigned = isUnsignedApkPath(p);
          let size = "";
          try {
            size = ` (${(fs.statSync(p).size / 1048576).toFixed(1)} MB)`;
          } catch {
            size = "";
          }
          const rel = path.relative(projectRoot, p);
          const tag = unsigned ? "[UNSIGNED]" : debug ? "[DEBUG]" : "[release]";
          return {
            name: `${rel}  ${tag}${size}`,
            value: p,
          };
        }),
      });
      apkFile = picked;
    }
  }

  // 6) Verify what is really inside the APK (AGP cannot inject the version)
  // 6b) Debug-APK guard: a debuggable APK must never become a production
  // update (it cannot install over a release build / it IS a debug build),
  // and a release app must never be offered a debug APK as an update.
  const pickedLooksDebug = isDebugApkPath(apkFile);
  const pickedIsUnsigned = isUnsignedApkPath(apkFile);
  if (pickedIsUnsigned) {
    console.warn(
      "\n⚠️ This APK is UNSIGNED - Android cannot install it over (or instead of) " +
        "a signed release build.\n" +
        "   Fix the signing config (APPUPDATE_KEYSTORE_* or android/keystore.properties) and rebuild.",
    );
    if (!cli.assumeYes) {
      const proceed = await confirm({
        message: "Upload this UNSIGNED APK anyway?",
        default: false,
      });
      if (!proceed) process.exit(1);
    }
  }
  if (pickedLooksDebug) {
    console.warn(
      "\n⚠️ This looks like a DEBUG (debuggable) APK. " +
        "Debug APKs cannot update a release install and must not be published as updates.",
    );
    if (config.ENVIRONMENT === "production" && !cli.allowDebugApk) {
      console.error(
        "❌ Refusing to upload a debug APK for the production environment.\n" +
          "   Re-run with --allow-debug-apk only if you really mean it (e.g. internal testing).",
      );
      process.exit(1);
    }
    if (!cli.allowDebugApk && !cli.assumeYes) {
      const proceed = await confirm({
        message: "Upload this DEBUG APK anyway (development only)?",
        default: false,
      });
      if (!proceed) {
        console.error(
          "❌ Aborted. Build a release APK (assembleRelease) and re-run.",
        );
        process.exit(1);
      }
    }
  }

  const registration = await resolveRegistrationMetadata({
    apkFile,
    entered: {
      packageName: variant.appId,
      versionName,
      versionCode: Number(versionCode),
    },
    assumeYes: cli.assumeYes,
  });
  // Keep the debug marker for registration + runtime guard.
  registration.isDebugApk = pickedLooksDebug;
  registration.buildType = pickedLooksDebug ? "debug" : "release";

  // 7) S3 upload + server registration
  console.log(`\n📤 Uploading APK to server...`);
  try {
    const s3Result = await uploadFileToS3(
      apkFile,
      DecriptEnv(APPUPDATE_AWS_BUCKET_NAME),
      `uploads/${config.ENVIRONMENT}/apk`,
      "application/vnd.android.package-archive",
    );

    console.log(`✅ S3 Upload Complete: ${s3Result.Key}`);
    console.log(`📝 Registering APK with backend API...`);

    const stats = fs.statSync(apkFile);

    const payload = {
      projectId: config.PROJECT_ID,
      environment: config.ENVIRONMENT,
      platform: "android",
      packageName: registration.packageName,
      versionName: registration.versionName,
      versionCode: Number(registration.versionCode),
      buildType: registration.buildType,
      isDebugApk: registration.isDebugApk,
      forceUpdate,
      s3Key: s3Result.Key,
      s3Url: s3Result.Location,
      fileName: path.basename(apkFile),
      fileSize: stats.size,
      variant: variant.name,
    };

    console.log(
      `   ${payload.packageName} v${payload.versionName} (versionCode ${payload.versionCode}, ${payload.buildType}), ${(
        payload.fileSize /
        (1024 * 1024)
      ).toFixed(1)} MB`,
    );

    // joinUrl avoids `https://host//apks` (trailing slash in .env) which
    // many backends answer with 404 "route not found".
    const apksUrl = joinUrl(APPUPDATE_BASE_URL, "/apks");
    let res;
    try {
      res = await axios.post(apksUrl, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.API_TOKEN}`,
          "Api-Key": APPUPDATE_API_KEY,
        },
      });
    } catch (postErr) {
      if (postErr?.response?.status === 404) {
        console.error(
          `❌ APK upload failed: server returned 404 for POST ${apksUrl} ("route not found").`,
        );
        console.error(
          "   Check APPUPDATE_BASE_URL in your app .env - it must be the API root " +
            "(e.g. https://api.example.com, no trailing path like /api/v1 unless your server mounts routes there).",
        );
        console.error(
          "   Also confirm the backend exposes POST /apks (same server that serves POST /bundles).",
        );
      }
      throw postErr;
    }

    console.log(
      `✅ APK registered! Response:`,
      JSON.stringify(res.data, null, 2),
    );
  } catch (err) {
    console.error(`❌ APK upload failed!`);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error(
        "Data:",
        typeof err.response.data === "string"
          ? err.response.data
          : JSON.stringify(err.response.data, null, 2),
      );
    } else {
      console.error("Message:", err.message);
    }
    process.exit(1);
  }

  console.log("\n🎉 APK release build & upload completed successfully!");
  console.log(
    "   Devices running an older versionCode will now be prompted to install this APK in-app.\n",
  );
}

main().catch((err) => {
  console.error(`❌ ${err?.message ?? err}`);
  process.exit(1);
});
