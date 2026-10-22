import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");
const FAKE_MCODE = path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs");
const FIXTURES_DIR = path.join(ROOT_DIR, "tests/fixtures");

const tempDirsToClean = [];

export function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

try {
  afterEach(() => {
    cleanupTempDirs();
  });
} catch {
  // Ignore if afterEach is called outside test context
}

export function runCompanion(args, options = {}) {
  const pluginDataDir = options.pluginDataDir ?? makeTempDir("mcode-test-data-");
  const binDir = makeTempDir("mcode-test-bin-");

  if (!options.noMcodeOnPath && !options.useRealMcode) {
    const symlinkPath = path.join(binDir, "mcode");
    try {
      fs.symlinkSync(FAKE_MCODE, symlinkPath);
    } catch {
      fs.copyFileSync(FAKE_MCODE, symlinkPath);
      fs.chmodSync(symlinkPath, 0o755);
    }
  }

  const recordArgvFile = path.join(pluginDataDir, "recorded-argv.json");
  const recordCwdFile = path.join(pluginDataDir, "recorded-cwd.json");
  const recordStdinFile = path.join(pluginDataDir, "recorded-stdin.txt");

  const nodeDir = path.dirname(process.execPath);
  const pathEnv = options.useRealMcode
    ? process.env.PATH
    : options.noMcodeOnPath
      ? `${nodeDir}:/usr/bin:/bin`
      : `${binDir}:${process.env.PATH}`;

  const combinedEnv = {
    ...process.env,
    PATH: pathEnv,
    MCODE_PLUGIN_DATA: pluginDataDir,
    MCODE_CLAUDE_SESSION_ID: options.sessionId ?? "test-claude-session-001",
    MCODE_RECORD_ARGV: recordArgvFile,
    MCODE_RECORD_CWD: recordCwdFile,
    MCODE_RECORD_STDIN: recordStdinFile,
    MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl"),
    ...(options.env ?? {})
  };

  const cwd = options.cwd ?? ROOT_DIR;
  const result = spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd,
    env: combinedEnv,
    encoding: "utf8"
  });

  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const error = result.error ?? null;

  const recordedArgv = fs.existsSync(recordArgvFile)
    ? JSON.parse(fs.readFileSync(recordArgvFile, "utf8"))
    : null;
  const recordedCwd = fs.existsSync(recordCwdFile)
    ? fs.readFileSync(recordCwdFile, "utf8").trim()
    : null;
  const recordedStdin = fs.existsSync(recordStdinFile)
    ? fs.readFileSync(recordStdinFile, "utf8")
    : null;

  return { status, stdout, stderr, error, recordedArgv, recordedCwd, recordedStdin, pluginDataDir };
}
