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

function waitForJob(pluginDataDir, jobId, predicate, timeoutMs = 15000) {
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

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function startMidStreamBackgroundJob(pluginDataDir, title) {
  const launch = runCompanion(["delegate", "--background", "--json", title], {
    pluginDataDir,
    env: MID_STREAM
  });
  assert.equal(launch.status, 0, launch.stderr);
  const { id } = JSON.parse(launch.stdout);

  let running;
  try {
    running = waitForJob(pluginDataDir, id, (j) => j.status === "running" && j.processId && j.mcodeSessionId);
  } catch (err) {
    try { killGroup(readJob(pluginDataDir, id).processId); } catch {}
    throw err;
  }
  return running;
}

function seedJob(pluginDataDir, job) {
  const stateRoot = path.join(pluginDataDir, "state");
  const stateDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  const stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.jobs.unshift(job);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  fs.writeFileSync(path.join(stateDir, "jobs", `${job.id}.json`), JSON.stringify(job, null, 2), "utf8");
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
  const child = spawnCompanion(["delegate", "foreground task"], {
    pluginDataDir,
    env: { ...MID_STREAM, MCODE_RECORD_PID: pidFile }
  });

  try {
    const start = Date.now();
    let jobs = [];
    while (!(jobs[0]?.mcodeSessionId && fs.existsSync(pidFile))) {
      assert.ok(Date.now() - start < 15000, "foreground Job never reported its mcode session");
      pause(100);
      jobs = JSON.parse(runCompanion(["status", "--json"], { pluginDataDir }).stdout);
    }
    const mcodePid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    const jobId = jobs[0].id;

    child.kill("SIGTERM");
    await waitForExit(child);

    assert.ok(waitForPidExit(mcodePid), "mcode child should be terminated with the companion");
    const job = readJob(pluginDataDir, jobId);
    assert.equal(job.status, "cancelled");

    const result = runCompanion(["result", jobId], { pluginDataDir });
    assert.match(result.stdout, /mcode delegation was cancelled\./);
    assert.match(result.stdout, new RegExp(`mcode session: ${FIXTURE_SESSION_ID}`));
  } finally {
    child.kill("SIGKILL");
    if (fs.existsSync(pidFile)) {
      try { process.kill(parseInt(fs.readFileSync(pidFile, "utf8"), 10), "SIGKILL"); } catch {}
    }
  }
});

test("a Job whose process died without recording a result is reported as lost and can be resumed", () => {
  const pluginDataDir = makeTempDir("mcode-test-lifecycle-");
  const running = startMidStreamBackgroundJob(pluginDataDir, "task that gets killed");
  killGroup(running.processId);
  assert.ok(waitForPidExit(running.processId), "worker should be gone after SIGKILL");

  const job = readJob(pluginDataDir, running.id);
  assert.equal(job.status, "failed");
  assert.equal(job.reason, "process-lost");

  const result = runCompanion(["result", running.id], { pluginDataDir });
  assert.match(result.stdout, /mcode delegation stopped without recording a result\./);
  assert.match(result.stdout, new RegExp(`mcode session: ${FIXTURE_SESSION_ID}`));

  const resumed = runCompanion(["delegate", "--resume", "continue"], { pluginDataDir });
  assert.equal(resumed.status, 0, resumed.stderr);
  const sessionFlag = resumed.recordedArgv.indexOf("--session");
  assert.ok(sessionFlag >= 0, `expected --session in ${JSON.stringify(resumed.recordedArgv)}`);
  assert.equal(resumed.recordedArgv[sessionFlag + 1], FIXTURE_SESSION_ID);
});

test("status --wait reports a Job as lost when its worker dies during the wait", async () => {
  const pluginDataDir = makeTempDir("mcode-test-lifecycle-");
  const running = startMidStreamBackgroundJob(pluginDataDir, "task killed while waited on");

  const waiter = spawnCompanion(["status", running.id, "--wait", "--timeout-ms", "12000"], { pluginDataDir });
  try {
    pause(500);
    killGroup(running.processId);
    const code = await waitForExit(waiter, 8000);
    assert.equal(code, 0, "status --wait should return once the Job is marked lost, not time out");

    const job = readJob(pluginDataDir, running.id);
    assert.equal(job.status, "failed");
    assert.equal(job.reason, "process-lost");
  } finally {
    killGroup(running.processId);
    waiter.kill("SIGKILL");
  }
});

test("a queued Job whose worker never started stops blocking resume", () => {
  const pluginDataDir = makeTempDir("mcode-test-lifecycle-");
  const first = runCompanion(["delegate", "finished delegation"], { pluginDataDir });
  assert.equal(first.status, 0, first.stderr);

  const longAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  seedJob(pluginDataDir, {
    id: "delegate-stale-queued",
    kind: "delegate",
    title: "worker never started",
    status: "queued",
    sessionId: "test-claude-session-001",
    processId: null,
    createdAt: longAgo,
    updatedAt: longAgo
  });

  const resumed = runCompanion(["delegate", "--resume", "continue"], { pluginDataDir });
  assert.equal(resumed.status, 0, resumed.stderr);

  const stale = readJob(pluginDataDir, "delegate-stale-queued");
  assert.equal(stale.status, "failed");
  assert.equal(stale.reason, "process-lost");
});
