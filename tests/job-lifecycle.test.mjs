import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { makeTempDir, runCompanion, spawnCompanion } from "./helpers/run-companion.mjs";

const FIXTURE_SESSION_ID = "mvs_e833006d348440b38a85b16f960606ce";
const MID_STREAM = { MCODE_SLEEP_AFTER_LINES: "1", MCODE_SLEEP_MS: "15000" };

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJob(pluginDataDir, jobId) {
  const res = runCompanion(["status", jobId, "--json"], { pluginDataDir });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function waitForJob(pluginDataDir, jobId, predicate, timeoutMs = 8000) {
  const start = Date.now();
  let job = readJob(pluginDataDir, jobId);
  while (!predicate(job)) {
    assert.ok(Date.now() - start < timeoutMs, `Timed out waiting on Job ${jobId}: ${JSON.stringify({ status: job.status, mcodeSessionId: job.mcodeSessionId })}`);
    pause(100);
    job = readJob(pluginDataDir, jobId);
  }
  return job;
}

function waitForPidExit(pid, timeoutMs = 5000) {
  const start = Date.now();
  while (isPidAlive(pid) && Date.now() - start < timeoutMs) {
    pause(50);
  }
  return !isPidAlive(pid);
}

test("mcode session id is recorded on the Job while the run is still going", () => {
  const pluginDataDir = makeTempDir("mcode-test-lifecycle-");
  const launch = runCompanion(["delegate", "--background", "--json", "long task"], {
    pluginDataDir,
    env: MID_STREAM
  });
  assert.equal(launch.status, 0, launch.stderr);
  const { id } = JSON.parse(launch.stdout);

  try {
    const job = waitForJob(pluginDataDir, id, (j) => j.mcodeSessionId);
    assert.equal(job.status, "running");
    assert.equal(job.mcodeSessionId, FIXTURE_SESSION_ID);
  } finally {
    runCompanion(["cancel", id], { pluginDataDir });
  }
});

test("a foreground delegation stopped by SIGTERM is recorded as cancelled and keeps its mcode session", async () => {
  const pluginDataDir = makeTempDir("mcode-test-lifecycle-");
  const pidFile = path.join(pluginDataDir, "mcode.pid");
  const { child } = spawnCompanion(["delegate", "foreground task"], {
    pluginDataDir,
    env: { ...MID_STREAM, MCODE_RECORD_PID: pidFile }
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));

  let mcodePid = null;
  try {
    const start = Date.now();
    let jobs = [];
    while (!(jobs[0]?.mcodeSessionId && fs.existsSync(pidFile))) {
      assert.ok(Date.now() - start < 8000, "foreground Job never reported its mcode session");
      pause(100);
      jobs = JSON.parse(runCompanion(["status", "--json"], { pluginDataDir }).stdout);
    }
    mcodePid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    const jobId = jobs[0].id;

    child.kill("SIGTERM");
    await exited;

    assert.ok(waitForPidExit(mcodePid), "mcode child should be terminated with the companion");
    const job = readJob(pluginDataDir, jobId);
    assert.equal(job.status, "cancelled");

    const result = runCompanion(["result", jobId], { pluginDataDir });
    assert.match(result.stdout, /mcode delegation was cancelled\./);
    assert.match(result.stdout, new RegExp(`mcode session: ${FIXTURE_SESSION_ID}`));
  } finally {
    child.kill("SIGKILL");
    if (mcodePid) {
      try { process.kill(mcodePid, "SIGKILL"); } catch {}
    }
  }
});

test("a Job whose process died without recording a result is reported as lost and stays resumable", () => {
  const pluginDataDir = makeTempDir("mcode-test-lifecycle-");
  const launch = runCompanion(["delegate", "--background", "--json", "task that gets killed"], {
    pluginDataDir,
    env: MID_STREAM
  });
  assert.equal(launch.status, 0, launch.stderr);
  const { id } = JSON.parse(launch.stdout);

  let running;
  try {
    running = waitForJob(pluginDataDir, id, (j) => j.status === "running" && j.processId && j.mcodeSessionId);
  } finally {
    const workerPid = running?.processId ?? readJob(pluginDataDir, id).processId;
    if (workerPid) {
      try { process.kill(-workerPid, "SIGKILL"); } catch {}
      try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
  }
  assert.ok(waitForPidExit(running.processId), "worker should be gone after SIGKILL");

  const job = readJob(pluginDataDir, id);
  assert.equal(job.status, "failed");
  assert.equal(job.reason, "process-lost");

  const result = runCompanion(["result", id], { pluginDataDir });
  assert.match(result.stdout, /mcode delegation stopped without recording a result\./);
  assert.match(result.stdout, new RegExp(`mcode session: ${FIXTURE_SESSION_ID}`));

  const candidate = runCompanion(["resume-candidate", "--json"], { pluginDataDir });
  assert.equal(candidate.status, 0, candidate.stderr);
  const parsed = JSON.parse(candidate.stdout);
  assert.equal(parsed.hasCandidate, true);
  assert.equal(parsed.mcodeSessionId, FIXTURE_SESSION_ID);
});
