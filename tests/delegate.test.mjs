import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");
const FAKE_MCODE = path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs");
const FIXTURES_DIR = path.join(ROOT_DIR, "tests/fixtures");

function runCompanion(args, options = {}) {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-data-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-bin-"));

  if (!options.noMcodeOnPath) {
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
  const combinedEnv = {
    ...process.env,
    PATH: options.noMcodeOnPath ? `${nodeDir}:/usr/bin:/bin` : `${binDir}:${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    CLAUDE_SESSION_ID: "test-claude-session-001",
    MCODE_RECORD_ARGV: recordArgvFile,
    MCODE_RECORD_CWD: recordCwdFile,
    MCODE_RECORD_STDIN: recordStdinFile,
    ...(options.env ?? {})
  };

  const cwd = options.cwd ?? ROOT_DIR;

  try {
    const stdout = execFileSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      cwd,
      env: combinedEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    let recordedArgv = null;
    let recordedCwd = null;
    let recordedStdin = null;
    if (fs.existsSync(recordArgvFile)) {
      recordedArgv = JSON.parse(fs.readFileSync(recordArgvFile, "utf8"));
    }
    if (fs.existsSync(recordCwdFile)) {
      recordedCwd = fs.readFileSync(recordCwdFile, "utf8").trim();
    }
    if (fs.existsSync(recordStdinFile)) {
      recordedStdin = fs.readFileSync(recordStdinFile, "utf8");
    }

    return { status: 0, stdout, stderr: "", recordedArgv, recordedCwd, recordedStdin, pluginDataDir };
  } catch (err) {
    let recordedArgv = null;
    let recordedCwd = null;
    let recordedStdin = null;
    if (fs.existsSync(recordArgvFile)) {
      recordedArgv = JSON.parse(fs.readFileSync(recordArgvFile, "utf8"));
    }
    if (fs.existsSync(recordCwdFile)) {
      recordedCwd = fs.readFileSync(recordCwdFile, "utf8").trim();
    }
    if (fs.existsSync(recordStdinFile)) {
      recordedStdin = fs.readFileSync(recordStdinFile, "utf8");
    }

    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? "",
      error: err,
      recordedArgv,
      recordedCwd,
      recordedStdin,
      pluginDataDir
    };
  }
}

test("delegate uses smart permission by default, --input - and pipes prompt via stdin", () => {
  const res = runCompanion(["delegate", "inspect", "the", "system"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  assert.ok(res.recordedArgv.includes("--permission"));
  assert.equal(res.recordedArgv[res.recordedArgv.indexOf("--permission") + 1], "smart");
  assert.ok(res.recordedArgv.includes("--input"));
  assert.equal(res.recordedArgv[res.recordedArgv.indexOf("--input") + 1], "-");
  assert.equal(res.recordedStdin, "inspect the system");
  assert.ok(res.stdout.includes("OK"));
  assert.ok(res.stdout.includes("mcode session: mvs_e833006d348440b38a85b16f960606ce"));
  assert.ok(res.stdout.includes("mcode --session mvs_e833006d348440b38a85b16f960606ce"));
});

test("delegate wraps prompt with read-only contract when --read-only is passed", () => {
  const res = runCompanion(["delegate", "--read-only", "diagnose memory leak"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  assert.ok(res.recordedStdin.includes("read-only investigation"));
  assert.ok(res.recordedStdin.includes("MUST NOT create, modify, or delete any file"));
  assert.ok(res.recordedStdin.includes("diagnose memory leak"));
});

test("delegate does not wrap prompt when --read-only is not passed", () => {
  const res = runCompanion(["delegate", "implement feature"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  assert.equal(res.recordedStdin, "implement feature");
});

test("delegate uses invocation cwd for --cwd and git toplevel for Job store", () => {
  const subDir = path.join(ROOT_DIR, "plugins/mcode");
  const res = runCompanion(["delegate", "--json", "task in subfolder"], {
    cwd: subDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  const cwdIndex = res.recordedArgv.indexOf("--cwd");
  assert.ok(cwdIndex >= 0);
  assert.equal(res.recordedArgv[cwdIndex + 1], subDir);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "completed");
});

test("persists Job as failed with reason mcode-not-found when mcode is missing from PATH", () => {
  const res = runCompanion(["delegate", "--json", "task with no mcode"], {
    noMcodeOnPath: true
  });

  assert.notEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.reason, "mcode-not-found");
  assert.ok(parsed.error.message.includes("/mcode:setup"));
});

test("persists Job as failed with reason unsupported-output-version when schemaVersion is invalid", () => {
  const tempFixture = path.join(os.tmpdir(), "unknown-schema-test.jsonl");
  fs.writeFileSync(tempFixture, JSON.stringify({ schemaVersion: 99, type: "exec.started" }) + "\n");

  const res = runCompanion(["delegate", "--json", "task with bad schema"], {
    env: { MCODE_FIXTURE: tempFixture }
  });

  assert.notEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.reason, "unsupported-output-version");
  assert.ok(parsed.error.message.includes("Unsupported mcode output version: 99"));
  fs.unlinkSync(tempFixture);
});

test("delegate uses full permission only when --full is requested", () => {
  const res = runCompanion(["delegate", "--full", "modify codebase"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  assert.equal(res.recordedArgv[res.recordedArgv.indexOf("--permission") + 1], "full");
});

test("delegate re-splits raw-arguments string", () => {
  const res = runCompanion([
    "delegate",
    "--raw-arguments",
    "--model custom/test-model --effort high 'fix formatting in files'"
  ], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  assert.equal(res.recordedArgv[res.recordedArgv.indexOf("--model") + 1], "custom/test-model");
  assert.equal(res.recordedArgv[res.recordedArgv.indexOf("--effort") + 1], "high");
  assert.equal(res.recordedStdin, "fix formatting in files");
});

test("delegate outputs structured JSON when --json is provided", () => {
  const res = runCompanion(["delegate", "--json", "quick task"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.reason, null);
  assert.equal(parsed.mcodeSessionId, "mvs_e833006d348440b38a85b16f960606ce");
  assert.equal(parsed.output, "OK");
  assert.ok(parsed.id.startsWith("delegate-"));
});

test("surfaces mcode CLI validation errors when execution fails immediately", () => {
  const res = runCompanion(["delegate", "invalid effort probe"], {
    env: {
      MCODE_FAIL_EXIT_CODE: "2",
      MCODE_STDERR: "mcode exec failed: --effort invalid_effort is not available"
    }
  });

  assert.equal(res.status, 2);
  assert.ok(res.stdout.includes("mcode delegation failed"));
  assert.ok(res.stdout.includes("--effort invalid_effort is not available"));
});

test("maps invalid model stream failure to failed status", () => {
  const res = runCompanion(["delegate", "--json", "probe invalid model"], {
    env: {
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "invalid-model.stream.jsonl"),
      MCODE_EXIT_CODE: "4"
    }
  });

  assert.equal(res.status, 4);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.reason, "error");
  assert.ok(parsed.error.message.includes("Model \"nonexistent/model\" is not available"));
});

test("handles permission-denied-handled run with status completed", () => {
  const res = runCompanion(["delegate", "--json", "outside write handled"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "permission-denied-handled.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "completed");
  assert.ok(parsed.output.includes("Direct write outside working directory was blocked"));
});

test("maps INTERACTION_NOT_AVAILABLE to failed status with reason needs-interaction", () => {
  const res = runCompanion(["delegate", "interaction required"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "needs-interaction.stream.jsonl") }
  });

  assert.notEqual(res.status, 0);
  assert.ok(res.stdout.includes("mcode requires interaction that is not available in headless mode"));
  assert.ok(res.stdout.includes("mcode --session mvs_interact_9876543210ab"));
});

test("maps timeout to failed status with reason timeout", () => {
  const res = runCompanion(["delegate", "--json", "slow operation"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "timeout.stream.jsonl") }
  });

  assert.notEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.reason, "timeout");
});

test("maps limit_exceeded to failed status with reason limit_exceeded", () => {
  const res = runCompanion(["delegate", "--json", "long loop"], {
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "limit-exceeded.stream.jsonl") }
  });

  assert.notEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.reason, "limit_exceeded");
});
