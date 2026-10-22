import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir, runCompanion } from "./helpers/run-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(ROOT_DIR, "tests/fixtures");
const SESSION_END_HOOK = path.join(ROOT_DIR, "plugins/mcode/scripts/session-end.mjs");

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runSessionEndHook(stdinJson, env = {}) {
  const nodeDir = path.dirname(process.execPath);
  const combinedEnv = {
    ...process.env,
    PATH: `${nodeDir}:/usr/bin:/bin`,
    ...env
  };
  if (!("MCODE_PLUGIN_DATA" in env)) {
    delete combinedEnv.MCODE_PLUGIN_DATA;
  }

  const result = spawnSync(process.execPath, [SESSION_END_HOOK], {
    env: combinedEnv,
    input: typeof stdinJson === "string" ? stdinJson : JSON.stringify(stdinJson),
    encoding: "utf8"
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

test("delegate --background writes queued Job, prints guidance, and worker executes in background", () => {
  const pluginDataDir = makeTempDir("mcode-test-bg-");

  const res = runCompanion(["delegate", "--background", "background task test"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Job delegate-[a-z0-9-]+/);
  assert.match(res.stdout, /\/mcode:status delegate-[a-z0-9-]+/);
  assert.match(res.stdout, /\/mcode:result delegate-[a-z0-9-]+/);
  assert.match(res.stdout, /\/mcode:cancel delegate-[a-z0-9-]+/);

  const match = res.stdout.match(/(delegate-[a-z0-9-]+)/);
  assert.ok(match);
  const jobId = match[1];

  let completed = false;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const statusRes = runCompanion(["status", jobId, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "completed") {
        completed = true;
        assert.equal(typeof job.processId, "number");
        assert.ok(job.processId > 0);
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  assert.ok(completed, "Background worker should complete the job");

  const resultRes = runCompanion(["result", jobId], { pluginDataDir });
  assert.equal(resultRes.status, 0);
  assert.ok(resultRes.stdout.includes("OK"));
});

test("delegate --background --json returns queued Job payload immediately", () => {
  const pluginDataDir = makeTempDir("mcode-test-bg-json-");

  const res = runCompanion(["delegate", "--background", "--json", "json background task"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.match(parsed.id, /^delegate-/);
  assert.equal(parsed.status, "queued");
  assert.equal(parsed.title, "json background task");
});

test("delegate --background with --read-only evaluates workspace guard in worker", () => {
  const pluginDataDir = makeTempDir("mcode-test-bg-ro-");

  const res = runCompanion([
    "delegate",
    "--background",
    "--read-only",
    "read-only bg investigation"
  ], {
    pluginDataDir,
    env: {
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl"),
      MCODE_MUTATIONS: JSON.stringify([{ action: "create", path: "bg-created-file.txt", content: "bad edit\n" }])
    }
  });

  assert.equal(res.status, 0);
  const match = res.stdout.match(/(delegate-[a-z0-9-]+)/);
  assert.ok(match);
  const jobId = match[1];

  let completed = false;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const statusRes = runCompanion(["status", jobId, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "completed") {
        completed = true;
        assert.ok(job.readOnlyGuard);
        assert.ok(job.readOnlyGuard.changedPaths.includes("bg-created-file.txt"));
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  try {
    fs.unlinkSync(path.join(ROOT_DIR, "bg-created-file.txt"));
  } catch {}

  assert.ok(completed, "Worker should complete and record read-only violation");
});

test("delegate --background failure records failed status with reason in store", () => {
  const pluginDataDir = makeTempDir("mcode-test-bg-fail-");

  const res = runCompanion(["delegate", "--background", "--json", "failing background task"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "timeout.stream.jsonl") }
  });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);

  let finished = false;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const statusRes = runCompanion(["status", parsed.id, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "failed") {
        finished = true;
        assert.equal(job.reason, "timeout");
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  assert.ok(finished, "Background worker should record failed status");
});

test("status --wait waits until background Job finishes and prints details", () => {
  const pluginDataDir = makeTempDir("mcode-test-wait-");

  const bgRes = runCompanion(["delegate", "--background", "--json", "task to wait on"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(bgRes.status, 0);
  const bgJob = JSON.parse(bgRes.stdout);

  const waitRes = runCompanion(["status", bgJob.id, "--wait"], { pluginDataDir });
  assert.equal(waitRes.status, 0);
  assert.ok(waitRes.stdout.includes(`Job ID:         ${bgJob.id}`));
  assert.ok(waitRes.stdout.includes("State:          completed"));
});

test("status --wait returns immediately if Job is already finished", () => {
  const pluginDataDir = makeTempDir("mcode-test-wait-already-done-");

  const delRes = runCompanion(["delegate", "--json", "already finished task"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(delRes.status, 0);
  const job = JSON.parse(delRes.stdout);

  const start = Date.now();
  const waitRes = runCompanion(["status", job.id, "--wait", "--json"], { pluginDataDir });
  const duration = Date.now() - start;

  assert.equal(waitRes.status, 0);
  assert.ok(duration < 2000);
  const parsed = JSON.parse(waitRes.stdout);
  assert.equal(parsed.id, job.id);
  assert.equal(parsed.status, "completed");
});

test("status --wait without job id waits on newest Job of the session", () => {
  const pluginDataDir = makeTempDir("mcode-test-wait-newest-");

  const bgRes = runCompanion(["delegate", "--background", "--json", "newest task to wait on"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(bgRes.status, 0);
  const bgJob = JSON.parse(bgRes.stdout);

  const waitRes = runCompanion(["status", "--wait", "--json"], { pluginDataDir });
  assert.equal(waitRes.status, 0);
  const parsed = JSON.parse(waitRes.stdout);
  assert.equal(parsed.id, bgJob.id);
  assert.equal(parsed.status, "completed");
});

test("status --wait without job id reports error when session has no jobs", () => {
  const pluginDataDir = makeTempDir("mcode-test-wait-empty-");

  const waitRes = runCompanion(["status", "--wait"], { pluginDataDir });
  assert.notEqual(waitRes.status, 0);
  assert.ok(waitRes.stderr.includes("No Jobs found for this session"));
});

test("status --wait rejects invalid --timeout-ms value", () => {
  const waitRes = runCompanion(["status", "--wait", "--timeout-ms", "invalid"]);
  assert.notEqual(waitRes.status, 0);
  assert.ok(waitRes.stderr.includes("--timeout-ms must be a non-negative number"));
});

test("status --wait --timeout-ms reports timeout when Job does not finish, leaving Job untouched", (t) => {
  const pluginDataDir = makeTempDir("mcode-test-wait-timeout-");

  const bgRes = runCompanion(["delegate", "--background", "--json", "slow job"], {
    pluginDataDir,
    env: {
      MCODE_SLEEP_MS: "5000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  assert.equal(bgRes.status, 0);
  const bgJob = JSON.parse(bgRes.stdout);

  t.after(() => {
    runCompanion(["cancel", bgJob.id], { pluginDataDir });
  });

  const waitRes = runCompanion(["status", bgJob.id, "--wait", "--timeout-ms", "100"], {
    pluginDataDir
  });

  assert.notEqual(waitRes.status, 0);
  assert.ok(waitRes.stderr.includes(`Timed out waiting for Job ${bgJob.id} to finish`));

  const statusRes = runCompanion(["status", bgJob.id, "--json"], { pluginDataDir });
  assert.equal(statusRes.status, 0);
  const currentJob = JSON.parse(statusRes.stdout);
  assert.ok(currentJob.status === "running" || currentJob.status === "queued");

  runCompanion(["cancel", bgJob.id], { pluginDataDir });
});

test("cancel terminates running worker and its child mcode process group", () => {
  const pluginDataDir = makeTempDir("mcode-test-cancel-");
  const mcodePidFile = path.join(pluginDataDir, "mcode.pid");

  const bgRes = runCompanion(["delegate", "--background", "--json", "task to cancel"], {
    pluginDataDir,
    env: {
      MCODE_RECORD_PID: mcodePidFile,
      MCODE_SLEEP_MS: "10000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });

  assert.equal(bgRes.status, 0);
  const bgJob = JSON.parse(bgRes.stdout);

  let workerPid = null;
  let mcodePid = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (fs.existsSync(mcodePidFile)) {
      mcodePid = parseInt(fs.readFileSync(mcodePidFile, "utf8").trim(), 10);
    }
    const statusRes = runCompanion(["status", bgJob.id, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "running" && job.processId) {
        workerPid = job.processId;
      }
    }
    if (workerPid && mcodePid) {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  assert.ok(workerPid, "Worker PID should be recorded");
  assert.ok(mcodePid, "mcode PID should be recorded");
  assert.ok(isPidAlive(workerPid), "Worker should be alive before cancel");
  assert.ok(isPidAlive(mcodePid), "mcode should be alive before cancel");

  const cancelRes = runCompanion(["cancel", bgJob.id], { pluginDataDir });
  assert.equal(cancelRes.status, 0);
  assert.ok(cancelRes.stdout.includes(`Cancelled Job ${bgJob.id}`));

  assert.equal(isPidAlive(workerPid), false, "Worker process should be terminated");
  assert.equal(isPidAlive(mcodePid), false, "mcode child process should be terminated");

  const statusRes = runCompanion(["status", bgJob.id, "--json"], { pluginDataDir });
  assert.equal(statusRes.status, 0);
  const cancelledJob = JSON.parse(statusRes.stdout);
  assert.equal(cancelledJob.status, "cancelled");

  const resultRes = runCompanion(["result", bgJob.id], { pluginDataDir });
  assert.equal(resultRes.status, 0);
  assert.ok(resultRes.stdout.includes("mcode delegation was cancelled."));
});

test("cancel resolves job ID by unique prefix", (t) => {
  const pluginDataDir = makeTempDir("mcode-test-cancel-prefix-");
  const mcodePidFile = path.join(pluginDataDir, "mcode.pid");

  const bgRes = runCompanion(["delegate", "--background", "--json", "task prefix cancel"], {
    pluginDataDir,
    env: {
      MCODE_RECORD_PID: mcodePidFile,
      MCODE_SLEEP_MS: "10000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  assert.equal(bgRes.status, 0);
  const bgJob = JSON.parse(bgRes.stdout);

  let workerPid = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const statusRes = runCompanion(["status", bgJob.id, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "running" && job.processId) {
        workerPid = job.processId;
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(workerPid);

  t.after(() => {
    if (workerPid) {
      try { process.kill(-workerPid, "SIGKILL"); } catch {}
      try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
  });

  // Use unique prefix
  const prefix = bgJob.id.slice(0, 16);
  const cancelRes = runCompanion(["cancel", prefix, "--json"], { pluginDataDir });
  assert.equal(cancelRes.status, 0);
  const parsed = JSON.parse(cancelRes.stdout);
  assert.equal(parsed.id, bgJob.id);
  assert.equal(parsed.status, "cancelled");
  assert.equal(isPidAlive(workerPid), false);
});

test("cancel with no job-id cancels the newest active Job of the session", (t) => {
  const pluginDataDir = makeTempDir("mcode-test-cancel-default-");
  const mcodePidFile = path.join(pluginDataDir, "mcode.pid");

  const bgRes = runCompanion(["delegate", "--background", "--json", "task to cancel default"], {
    pluginDataDir,
    env: {
      MCODE_RECORD_PID: mcodePidFile,
      MCODE_SLEEP_MS: "10000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  assert.equal(bgRes.status, 0);
  const bgJob = JSON.parse(bgRes.stdout);

  let workerPid = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const statusRes = runCompanion(["status", bgJob.id, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "running" && job.processId) {
        workerPid = job.processId;
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(workerPid);

  t.after(() => {
    if (workerPid) {
      try { process.kill(-workerPid, "SIGKILL"); } catch {}
      try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
  });

  const cancelRes = runCompanion(["cancel", "--json"], { pluginDataDir });
  assert.equal(cancelRes.status, 0);
  const parsed = JSON.parse(cancelRes.stdout);
  assert.equal(parsed.id, bgJob.id);
  assert.equal(parsed.status, "cancelled");
  assert.equal(isPidAlive(workerPid), false);
});

test("cancel reports error when no running or queued jobs exist", () => {
  const pluginDataDir = makeTempDir("mcode-test-cancel-no-active-");

  const cancelRes = runCompanion(["cancel"], { pluginDataDir });
  assert.notEqual(cancelRes.status, 0);
  assert.ok(cancelRes.stderr.includes("No running or queued Jobs found for this session"));
});

test("cancel on an already finished Job reports clear error", () => {
  const pluginDataDir = makeTempDir("mcode-test-cancel-finished-");

  const res = runCompanion(["delegate", "--json", "finished task"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(res.status, 0);
  const job = JSON.parse(res.stdout);

  const cancelRes = runCompanion(["cancel", job.id], { pluginDataDir });
  assert.notEqual(cancelRes.status, 0);
  assert.ok(cancelRes.stderr.includes(`Job ${job.id} is already finished (status: completed)`));
});

test("cancel rejects unsupported options with clear message", () => {
  const res = runCompanion(["cancel", "--bogus-flag"]);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Unsupported option: --bogus-flag"));
  assert.ok(res.stderr.includes("Supported options: --json"));
});

test("SessionEnd hook cancels session's running Jobs, keeps finished records, and leaves other sessions untouched", (t) => {
  const pluginDataDir = makeTempDir("mcode-test-session-end-");

  const sessionA = "session-alpha";
  const sessionB = "session-beta";

  const pidAFile = path.join(pluginDataDir, "mcode-A.pid");
  const pidBFile = path.join(pluginDataDir, "mcode-B.pid");

  runCompanion(["delegate", "--json", "task finished in A"], {
    pluginDataDir,
    sessionId: sessionA,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  const jobARes = runCompanion(["delegate", "--background", "--json", "task running in A"], {
    pluginDataDir,
    sessionId: sessionA,
    env: {
      MCODE_RECORD_PID: pidAFile,
      MCODE_SLEEP_MS: "15000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  const jobA = JSON.parse(jobARes.stdout);

  runCompanion(["delegate", "--json", "task finished in B"], {
    pluginDataDir,
    sessionId: sessionB,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  const jobBRes = runCompanion(["delegate", "--background", "--json", "task running in B"], {
    pluginDataDir,
    sessionId: sessionB,
    env: {
      MCODE_RECORD_PID: pidBFile,
      MCODE_SLEEP_MS: "15000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  const jobB = JSON.parse(jobBRes.stdout);

  let workerPidA = null;
  let workerPidB = null;
  let mcodePidA = null;
  let mcodePidB = null;

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (fs.existsSync(pidAFile)) {
      mcodePidA = parseInt(fs.readFileSync(pidAFile, "utf8").trim(), 10);
    }
    if (fs.existsSync(pidBFile)) {
      mcodePidB = parseInt(fs.readFileSync(pidBFile, "utf8").trim(), 10);
    }
    const statusA = runCompanion(["status", jobA.id, "--json"], { pluginDataDir, sessionId: sessionA });
    if (statusA.status === 0) {
      const jA = JSON.parse(statusA.stdout);
      if (jA.status === "running" && jA.processId) workerPidA = jA.processId;
    }
    const statusB = runCompanion(["status", jobB.id, "--json"], { pluginDataDir, sessionId: sessionB });
    if (statusB.status === 0) {
      const jB = JSON.parse(statusB.stdout);
      if (jB.status === "running" && jB.processId) workerPidB = jB.processId;
    }

    if (workerPidA && workerPidB && mcodePidA && mcodePidB) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  t.after(() => {
    if (workerPidB) {
      try { process.kill(-workerPidB, "SIGKILL"); } catch {}
      try { process.kill(workerPidB, "SIGKILL"); } catch {}
    }
    if (mcodePidB) {
      try { process.kill(mcodePidB, "SIGKILL"); } catch {}
    }
  });

  assert.ok(workerPidA, "Session A worker PID recorded");
  assert.ok(workerPidB, "Session B worker PID recorded");
  assert.ok(mcodePidA, "Session A mcode PID recorded");
  assert.ok(mcodePidB, "Session B mcode PID recorded");

  assert.ok(isPidAlive(workerPidA));
  assert.ok(isPidAlive(mcodePidA));
  assert.ok(isPidAlive(workerPidB));
  assert.ok(isPidAlive(mcodePidB));

  const endRes = runSessionEndHook(
    { session_id: sessionA },
    { CLAUDE_PLUGIN_DATA: pluginDataDir }
  );
  assert.equal(endRes.status, 0);

  assert.equal(isPidAlive(workerPidA), false, "Session A worker should be terminated");
  assert.equal(isPidAlive(mcodePidA), false, "Session A mcode should be terminated");

  assert.equal(isPidAlive(workerPidB), true, "Session B worker should remain alive");
  assert.equal(isPidAlive(mcodePidB), true, "Session B mcode should remain alive");

  const statusResA = runCompanion(["status", "--json"], { pluginDataDir, sessionId: sessionA });
  assert.equal(statusResA.status, 0);
  const remainingA = JSON.parse(statusResA.stdout);
  assert.equal(remainingA.length, 2, "Session A should keep both Job records");
  const cancelledA = remainingA.find((j) => j.id === jobA.id);
  assert.equal(cancelledA.status, "cancelled", "Session A running Job should be marked cancelled");
  assert.equal(remainingA.filter((j) => j.status === "completed").length, 1, "Session A finished Job should be kept");

  const resultA = runCompanion(["result", jobA.id], { pluginDataDir, sessionId: sessionA });
  assert.equal(resultA.status, 0);
  assert.match(resultA.stdout, /mcode delegation was cancelled\./);

  const candidateA = runCompanion(["resume-candidate", "--json"], { pluginDataDir, sessionId: sessionA });
  assert.equal(candidateA.status, 0);
  assert.equal(JSON.parse(candidateA.stdout).hasCandidate, true, "Finished delegation should still be resumable after SessionEnd");

  const statusResB = runCompanion(["status", "--json"], { pluginDataDir, sessionId: sessionB });
  assert.equal(statusResB.status, 0);
  const remainingB = JSON.parse(statusResB.stdout);
  assert.equal(remainingB.length, 2, "Session B should retain its 2 Jobs");

  const stateDirs = fs.readdirSync(path.join(pluginDataDir, "state"));
  const jobsDir = path.join(pluginDataDir, "state", stateDirs[0], "jobs");
  assert.equal(fs.existsSync(path.join(jobsDir, `${jobA.id}.json`)), true);
  assert.equal(fs.existsSync(path.join(jobsDir, `${jobA.id}.log`)), true);

  assert.equal(fs.existsSync(path.join(jobsDir, `${jobB.id}.json`)), true);
  assert.equal(fs.existsSync(path.join(jobsDir, `${jobB.id}.log`)), true);

  if (workerPidB) {
    try { process.kill(-workerPidB, "SIGKILL"); } catch {}
    try { process.kill(workerPidB, "SIGKILL"); } catch {}
  }
  if (mcodePidB) {
    try { process.kill(mcodePidB, "SIGKILL"); } catch {}
  }
});

test("delegate --background from a subdirectory preserves invocation cwd and worker runs mcode with that cwd", () => {
  const pluginDataDir = makeTempDir("mcode-test-bg-subfolder-");
  const subDir = path.join(ROOT_DIR, "plugins/mcode");
  const recordArgvFile = path.join(pluginDataDir, "worker-argv.json");

  const res = runCompanion(["delegate", "--background", "--json", "bg task in subfolder"], {
    cwd: subDir,
    pluginDataDir,
    env: {
      MCODE_RECORD_ARGV: recordArgvFile,
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "queued");
  assert.equal(parsed.cwd, subDir);

  let finishedJob = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const statusRes = runCompanion(["status", parsed.id, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "completed") {
        finishedJob = job;
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  assert.ok(finishedJob, "Worker should complete the job");
  assert.equal(finishedJob.cwd, subDir);

  assert.ok(fs.existsSync(recordArgvFile));
  const workerArgv = JSON.parse(fs.readFileSync(recordArgvFile, "utf8"));
  const cwdIndex = workerArgv.indexOf("--cwd");
  assert.ok(cwdIndex >= 0);
  assert.equal(workerArgv[cwdIndex + 1], subDir);
});

test("cancelling a queued Job before its worker starts causes worker to exit without running", () => {
  const pluginDataDir = makeTempDir("mcode-test-queued-cancel-");
  const mcodePidFile = path.join(pluginDataDir, "mcode.pid");

  // Create an initial completed delegation to initialize state directory
  const initRes = runCompanion(["delegate", "--json", "initial task"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(initRes.status, 0);

  // Directly set up a queued job in the store (as in resume.test.mjs)
  const stateDir = path.join(pluginDataDir, "state", fs.readdirSync(path.join(pluginDataDir, "state"))[0]);
  const stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const queuedJob = {
    id: "delegate-queued-cancel-test",
    kind: "delegate",
    title: "task cancelled while queued",
    prompt: "task cancelled while queued",
    cwd: ROOT_DIR,
    workspace: ROOT_DIR,
    status: "queued",
    sessionId: "test-claude-session-001",
    processId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.jobs.unshift({
    id: queuedJob.id,
    kind: queuedJob.kind,
    title: queuedJob.title,
    status: queuedJob.status,
    sessionId: queuedJob.sessionId,
    createdAt: queuedJob.createdAt,
    updatedAt: queuedJob.updatedAt
  });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  fs.writeFileSync(path.join(stateDir, "jobs", `${queuedJob.id}.json`), JSON.stringify(queuedJob, null, 2), "utf8");

  // Cancel the queued Job before any worker starts
  const cancelRes = runCompanion(["cancel", queuedJob.id, "--json"], { pluginDataDir });
  assert.equal(cancelRes.status, 0);

  // Now invoke delegate-worker; it must exit without flipping status or running mcode
  const workerRes = runCompanion(["delegate-worker", "--job-id", queuedJob.id], {
    pluginDataDir,
    env: {
      MCODE_RECORD_PID: mcodePidFile,
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  assert.equal(workerRes.status, 0);

  // Fake mcode was never invoked
  assert.equal(fs.existsSync(mcodePidFile), false);

  // Job status remains cancelled
  const statusRes = runCompanion(["status", queuedJob.id, "--json"], { pluginDataDir });
  assert.equal(statusRes.status, 0);
  const finalJob = JSON.parse(statusRes.stdout);
  assert.equal(finalJob.status, "cancelled");
});

test("cancel on foreground Job terminates companion and child mcode without orphaning", async (t) => {
  const pluginDataDir = makeTempDir("mcode-test-cancel-fg-");
  const mcodePidFile = path.join(pluginDataDir, "mcode.pid");

  const binDir = makeTempDir("mcode-test-bin-fg-");
  const symlinkPath = path.join(binDir, "mcode");
  try {
    fs.symlinkSync(path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs"), symlinkPath);
  } catch {
    fs.copyFileSync(path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs"), symlinkPath);
    fs.chmodSync(symlinkPath, 0o755);
  }

  const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");

  const foregroundProc = spawn(process.execPath, [COMPANION_SCRIPT, "delegate", "--json", "foreground task to cancel"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      MCODE_PLUGIN_DATA: pluginDataDir,
      MCODE_CLAUDE_SESSION_ID: "test-fg-session",
      MCODE_RECORD_PID: mcodePidFile,
      MCODE_SLEEP_MS: "15000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let companionExited = false;
  foregroundProc.on("exit", () => {
    companionExited = true;
  });

  const companionPid = foregroundProc.pid;
  let mcodePid = null;

  t.after(() => {
    if (companionPid) {
      try { process.kill(companionPid, "SIGKILL"); } catch {}
    }
    if (mcodePid) {
      try { process.kill(mcodePid, "SIGKILL"); } catch {}
    }
  });

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (fs.existsSync(mcodePidFile)) {
      mcodePid = parseInt(fs.readFileSync(mcodePidFile, "utf8").trim(), 10);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(companionPid, "Foreground companion PID should exist");
  assert.ok(mcodePid, "Foreground mcode PID should exist");
  assert.ok(!companionExited, "Companion should be alive");
  assert.ok(isPidAlive(mcodePid), "mcode child should be alive");

  const cancelRes = runCompanion(["cancel", "--json"], {
    pluginDataDir,
    sessionId: "test-fg-session"
  });
  assert.equal(cancelRes.status, 0);

  const termStart = Date.now();
  while (Date.now() - termStart < 3000) {
    if (companionExited && !isPidAlive(mcodePid)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(companionExited, true, "Foreground companion must be terminated");
  assert.equal(isPidAlive(mcodePid), false, "Child mcode must be terminated");
});

test("delegate --background honours --resume and worker passes --session to mcode", () => {
  const pluginDataDir = makeTempDir("mcode-test-bg-resume-");
  const recordArgvFile = path.join(pluginDataDir, "worker-argv.json");

  const firstRes = runCompanion(["delegate", "--json", "first step"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(firstRes.status, 0);
  const firstJob = JSON.parse(firstRes.stdout);
  assert.ok(firstJob.mcodeSessionId);

  const bgRes = runCompanion(["delegate", "--background", "--resume", "--json", "resumed background step"], {
    pluginDataDir,
    env: {
      MCODE_RECORD_ARGV: recordArgvFile,
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  assert.equal(bgRes.status, 0);
  const bgJob = JSON.parse(bgRes.stdout);
  assert.equal(bgJob.status, "queued");
  assert.equal(bgJob.mcodeSessionId, firstJob.mcodeSessionId);

  let finishedJob = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const statusRes = runCompanion(["status", bgJob.id, "--json"], { pluginDataDir });
    if (statusRes.status === 0) {
      const job = JSON.parse(statusRes.stdout);
      if (job.status === "completed") {
        finishedJob = job;
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  assert.ok(finishedJob, "Worker should complete the resumed job");
  assert.ok(fs.existsSync(recordArgvFile));
  const workerArgv = JSON.parse(fs.readFileSync(recordArgvFile, "utf8"));
  const sessionIndex = workerArgv.indexOf("--session");
  assert.ok(sessionIndex >= 0);
  assert.equal(workerArgv[sessionIndex + 1], firstJob.mcodeSessionId);
});
