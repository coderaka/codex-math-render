import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions, extractAll, getRawHeader } from "@electron/asar";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_FILE = path.join(REPO_ROOT, ".codex-math-render-state.json");

const INJECTION_TAG =
  '<script type="module" crossorigin src="./assets/codex-math-poc.js"></script>';

function usage() {
  console.error(
    "Usage: node install_codex_math_poc.mjs --app /path/to/Codex.app [--backup-dir /path] [--no-resign]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const result = {
    app: null,
    backupDir: null,
    resign: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app") {
      result.app = argv[index + 1];
      index += 1;
    } else if (arg === "--backup-dir") {
      result.backupDir = argv[index + 1];
      index += 1;
    } else if (arg === "--no-resign") {
      result.resign = false;
    } else {
      usage();
    }
  }

  if (!result.app) {
    usage();
  }

  return result;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyRecursive(src, dest) {
  await fs.cp(src, dest, { recursive: true, force: true, preserveTimestamps: true });
}

async function writeStateFile(state) {
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function injectIntoHtml(htmlPath) {
  const original = await fs.readFile(htmlPath, "utf8");
  if (original.includes(INJECTION_TAG)) {
    return false;
  }

  const marker = "</head>";
  const markerIndex = original.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find ${marker} in ${htmlPath}`);
  }

  const updated =
    original.slice(0, markerIndex) +
    `    ${INJECTION_TAG}\n` +
    original.slice(markerIndex);

  await fs.writeFile(htmlPath, updated, "utf8");
  return true;
}

async function updateInfoPlist(infoPlistPath, appAsarPath) {
  const rawHeader = await getRawHeader(appAsarPath);
  const headerHash = sha256(rawHeader.headerString);
  const plistJson = JSON.parse(
    await execFile("plutil", ["-convert", "json", "-o", "-", infoPlistPath]).then(
      ({ stdout }) => stdout
    )
  );

  plistJson.ElectronAsarIntegrity ??= {};
  plistJson.ElectronAsarIntegrity["Resources/app.asar"] = {
    algorithm: "SHA256",
    hash: headerHash
  };

  const tempJsonPath = `${infoPlistPath}.json.tmp`;
  await fs.writeFile(tempJsonPath, JSON.stringify(plistJson, null, 2));
  await execFile("plutil", ["-convert", "xml1", "-o", infoPlistPath, tempJsonPath]);
  await fs.unlink(tempJsonPath);

  return headerHash;
}

async function resignApp(appPath) {
  await execFile("codesign", ["--force", "--deep", "--sign", "-", appPath]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(args.app);
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const appAsarPath = path.join(resourcesDir, "app.asar");

  if (!(await pathExists(appAsarPath))) {
    throw new Error(`app.asar not found: ${appAsarPath}`);
  }

  if (!(await pathExists(infoPlistPath))) {
    throw new Error(`Info.plist not found: ${infoPlistPath}`);
  }

  const backupDir =
    args.backupDir ??
    path.join(
      os.tmpdir(),
      `${path.basename(appPath, ".app")}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.app`
    );

  if (!(await pathExists(backupDir))) {
    await copyRecursive(appPath, backupDir);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-math-poc-"));
  const extractedDir = path.join(workDir, "asar");

  try {
    await extractAll(appAsarPath, extractedDir);

    const htmlPath = path.join(extractedDir, "webview", "index.html");
    const assetsDir = path.join(extractedDir, "webview", "assets");
    const scriptPath = path.join(assetsDir, "codex-math-poc.js");

    await fs.mkdir(assetsDir, { recursive: true });
    const injected = await injectIntoHtml(htmlPath);
    await fs.copyFile(
      path.join(SCRIPT_DIR, "..", "src", "codex_math_poc.js"),
      scriptPath
    );

    await createPackageWithOptions(extractedDir, appAsarPath, {});
    const headerHash = await updateInfoPlist(infoPlistPath, appAsarPath);

    if (args.resign) {
      await resignApp(appPath);
    }

    await writeStateFile({
      updatedAt: new Date().toISOString(),
      appPath,
      backupDir,
      script: "install_codex_math_poc.mjs",
      headerHash,
      resigned: args.resign
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          appPath,
          backupDir,
          injected,
          headerHash,
          resigned: args.resign
        },
        null,
        2
      )
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
