import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_FILE = path.join(REPO_ROOT, ".codex-math-render-state.json");

function usage() {
  console.error(
    "Usage: node uninstall_codex_math_poc.mjs [--app /path/to/Codex.app] [--backup /path/to/Codex-backup.app]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const result = {
    app: null,
    backup: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app") {
      result.app = argv[index + 1];
      index += 1;
    } else if (arg === "--backup") {
      result.backup = argv[index + 1];
      index += 1;
    } else {
      usage();
    }
  }

  return result;
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

async function loadState() {
  if (!(await pathExists(STATE_FILE))) {
    return null;
  }

  return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
}

async function removeStateFile() {
  if (await pathExists(STATE_FILE)) {
    await fs.unlink(STATE_FILE);
  }
}

async function verifyApp(appPath) {
  await execFile("codesign", ["--verify", "--deep", "--strict", appPath]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = await loadState();

  const appPath = path.resolve(args.app ?? state?.appPath ?? "/Applications/Codex.app");
  const backupPath = args.backup
    ? path.resolve(args.backup)
    : state?.backupDir
      ? path.resolve(state.backupDir)
      : null;

  if (!backupPath) {
    throw new Error(
      `No backup path available. Pass --backup explicitly or restore from ${STATE_FILE}.`
    );
  }

  if (!(await pathExists(backupPath))) {
    throw new Error(`Backup app not found: ${backupPath}`);
  }

  await copyRecursive(backupPath, appPath);
  await verifyApp(appPath);
  await removeStateFile();

  console.log(
    JSON.stringify(
      {
        ok: true,
        appPath,
        restoredFrom: backupPath,
        stateCleared: true
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
