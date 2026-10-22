import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");

const isSmoke = process.env.MCODE_SMOKE === "1";

function cleanDir(dir) {
  if (!dir) return;
  for (let i = 0; i < 5; i += 1) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

test("real-mcode smoke test: delegate --read-only and review --wait", {
  skip: isSmoke ? false : "Skipping real-mcode smoke test (set MCODE_SMOKE=1 to run)",
  timeout: 600_000
}, () => {
  const tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-smoke-repo-"));
  const tempPluginData = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-smoke-data-"));

  try {
    const sessionId = `smoke-session-${Date.now()}`;
    const smokeEnv = {
      ...process.env,
      MCODE_PLUGIN_DATA: tempPluginData,
      MCODE_CLAUDE_SESSION_ID: sessionId
    };
    delete smokeEnv.MCODE_FIXTURE;
    delete smokeEnv.MCODE_RECORD_ARGV;
    delete smokeEnv.MCODE_RECORD_CWD;
    delete smokeEnv.MCODE_RECORD_STDIN;

    execFileSync("git", ["init"], { cwd: tempRepoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Smoke Test"], { cwd: tempRepoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "smoke@test.local"], { cwd: tempRepoDir, stdio: "ignore" });

    const testFile = path.join(tempRepoDir, "sample.txt");
    fs.writeFileSync(testFile, "initial sample line\n", "utf8");
    execFileSync("git", ["add", "sample.txt"], { cwd: tempRepoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tempRepoDir, stdio: "ignore" });

    const delegateRun = spawnSync(
      process.execPath,
      [COMPANION_SCRIPT, "delegate", "--read-only", "Reply with one word: Pong"],
      {
        cwd: tempRepoDir,
        env: smokeEnv,
        encoding: "utf8",
        timeout: 120_000
      }
    );

    assert.equal(delegateRun.status, 0, `delegate failed (${delegateRun.status}): ${delegateRun.stderr}`);
    assert.ok(delegateRun.stdout.trim().length > 0, "delegate output must not be empty");
    assert.match(delegateRun.stdout, /mcode session:\s+\S+/, "mcode session id must be present in output");
    assert.match(delegateRun.stdout, /To open this session in the mcode TUI: mcode --session\s+\S+/);

    const repoStatusAfter = execFileSync("git", ["status", "--porcelain"], {
      cwd: tempRepoDir,
      encoding: "utf8"
    });
    assert.equal(repoStatusAfter.trim(), "", "repository must remain unchanged after read-only delegation");

    const statusRun = spawnSync(
      process.execPath,
      [COMPANION_SCRIPT, "status", "--json"],
      {
        cwd: tempRepoDir,
        env: smokeEnv,
        encoding: "utf8",
        timeout: 30_000
      }
    );
    assert.equal(statusRun.status, 0);
    const jobs = JSON.parse(statusRun.stdout);
    assert.ok(Array.isArray(jobs) && jobs.length >= 1, "Job record must exist in status");
    assert.equal(jobs[0].status, "completed", "Job status must be completed");
    assert.ok(jobs[0].mcodeSessionId, "mcode session id must be stored on Job");

    fs.appendFileSync(testFile, "uncommitted modification for review\n", "utf8");

    const reviewRun = spawnSync(
      process.execPath,
      [COMPANION_SCRIPT, "review", "--wait"],
      {
        cwd: tempRepoDir,
        env: smokeEnv,
        encoding: "utf8",
        timeout: 300_000
      }
    );

    assert.equal(reviewRun.status, 0, `review failed (${reviewRun.status}): ${reviewRun.stderr}`);
    assert.match(reviewRun.stdout.trim(), /^Verdict:\s+/, "review output must start with Verdict:");
    assert.match(reviewRun.stdout, /mcode session:\s+\S+/, "session footer must be present in review output");
    assert.match(reviewRun.stdout, /To open this session in the mcode TUI: mcode --session\s+\S+/);
  } finally {
    cleanDir(tempRepoDir);
    cleanDir(tempPluginData);
  }
});
