import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir, runCompanion } from "./helpers/run-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(ROOT_DIR, "tests/fixtures");

test("resume-candidate reports hasCandidate: false when no jobs exist", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");
  const res = runCompanion(["resume-candidate", "--json"], {
    pluginDataDir,
    sessionId: "session-a"
  });

  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.hasCandidate, false);
  assert.equal(data.jobId, null);
  assert.equal(data.mcodeSessionId, null);
});

test("resume-candidate reports the newest finished Delegation in this Claude session with an mcode session id", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");

  // Run first delegation in session-a
  const run1 = runCompanion(["delegate", "first task"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run1.status, 0);

  const res1 = runCompanion(["resume-candidate", "--json"], {
    pluginDataDir,
    sessionId: "session-a"
  });
  assert.equal(res1.status, 0);
  const data1 = JSON.parse(res1.stdout);
  assert.equal(data1.hasCandidate, true);
  assert.equal(data1.mcodeSessionId, "mvs_e833006d348440b38a85b16f960606ce");
  assert.equal(data1.title, "first task");
  assert.ok(data1.jobId.startsWith("delegate-"));
  assert.ok(typeof data1.age === "string");
});

test("resume-candidate ignores delegations from other Claude sessions", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");

  // Run delegation in session-a
  const run1 = runCompanion(["delegate", "session-a task"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run1.status, 0);

  // Check candidate in session-b
  const resB = runCompanion(["resume-candidate", "--json"], {
    pluginDataDir,
    sessionId: "session-b"
  });
  assert.equal(resB.status, 0);
  const dataB = JSON.parse(resB.stdout);
  assert.equal(dataB.hasCandidate, false);
});

test("resume-candidate text output reports candidate when present and clear message when not", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");

  const noneRes = runCompanion(["resume-candidate"], {
    pluginDataDir,
    sessionId: "session-a"
  });
  assert.equal(noneRes.status, 0);
  assert.ok(noneRes.stdout.includes("No resume candidate found"));

  runCompanion(["delegate", "my task"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  const foundRes = runCompanion(["resume-candidate"], {
    pluginDataDir,
    sessionId: "session-a"
  });
  assert.equal(foundRes.status, 0);
  assert.ok(foundRes.stdout.includes("Resume candidate:"));
  assert.ok(foundRes.stdout.includes("mvs_e833006d348440b38a85b16f960606ce"));
  assert.ok(foundRes.stdout.includes("my task"));
});

test("resume-candidate ignores non-delegate jobs and delegations without mcode session id", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");

  // Run a delegation that fails without mcode (no mcodeSessionId)
  const failRun = runCompanion(["delegate", "missing mcode task"], {
    pluginDataDir,
    sessionId: "session-a",
    noMcodeOnPath: true
  });
  assert.notEqual(failRun.status, 0);

  const res1 = runCompanion(["resume-candidate", "--json"], {
    pluginDataDir,
    sessionId: "session-a"
  });
  assert.equal(res1.status, 0);
  assert.equal(JSON.parse(res1.stdout).hasCandidate, false);
});

test("resume-candidate rejects unsupported options and positional arguments", () => {
  const res1 = runCompanion(["resume-candidate", "--unknown"]);
  assert.notEqual(res1.status, 0);
  assert.ok(res1.stderr.includes("Unsupported option: --unknown"));

  const res2 = runCompanion(["resume-candidate", "extra-arg"]);
  assert.notEqual(res2.status, 0);
  assert.ok(res2.stderr.includes("Unexpected argument: \"extra-arg\""));
});

test("delegate rejects mutually exclusive --resume and --fresh", () => {
  const res = runCompanion(["delegate", "--resume", "--fresh", "conflicting task"]);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Cannot combine --resume and --fresh"));
});

test("delegate --resume with no candidate exits with clear error and does not run fresh", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");
  const res = runCompanion(["delegate", "--resume", "task with no candidate"], {
    pluginDataDir,
    sessionId: "session-a"
  });

  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("No resumable mcode session found for this Claude session"));
  assert.equal(res.recordedArgv, null);
});

test("delegate --resume passes --session with candidate mcode session id", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");

  const run1 = runCompanion(["delegate", "turn 1"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run1.status, 0);

  const run2 = runCompanion(["delegate", "--resume", "turn 2 delta"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run2.status, 0);
  assert.ok(run2.recordedArgv.includes("--session"));
  assert.equal(
    run2.recordedArgv[run2.recordedArgv.indexOf("--session") + 1],
    "mvs_e833006d348440b38a85b16f960606ce"
  );
  assert.equal(run2.recordedStdin, "turn 2 delta");
});

test("delegate --fresh forces new mcode session and omits --session even when candidate exists", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");

  const run1 = runCompanion(["delegate", "turn 1"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run1.status, 0);

  const run2 = runCompanion(["delegate", "--fresh", "turn 2 fresh"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run2.status, 0);
  assert.ok(!run2.recordedArgv.includes("--session"));
  assert.equal(run2.recordedStdin, "turn 2 fresh");
});

test("resume is refused with clear message while a Delegation of this Claude session is running", async () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");
  const binDir = makeTempDir("mcode-test-bin-");
  const fakeMcodePath = path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs");
  const symlinkPath = path.join(binDir, "mcode");
  try {
    fs.symlinkSync(fakeMcodePath, symlinkPath);
  } catch {
    fs.copyFileSync(fakeMcodePath, symlinkPath);
    fs.chmodSync(symlinkPath, 0o755);
  }

  // Create an initial completed delegation so there is a candidate
  const run1 = runCompanion(["delegate", "initial finished delegation"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run1.status, 0);

  // Now spawn a background delegation in the same session that sleeps
  const companionScript = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");
  const child = spawn(process.execPath, [companionScript, "delegate", "sleeping delegation"], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      MCODE_PLUGIN_DATA: pluginDataDir,
      MCODE_CLAUDE_SESSION_ID: "session-a",
      MCODE_SLEEP_MS: "3000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    },
    stdio: "pipe"
  });

  try {
    // Wait until the sleeping job is recorded as running
    const stateParentDir = path.join(pluginDataDir, "state");
    let isRunning = false;
    for (let i = 0; i < 50; i += 1) {
      if (fs.existsSync(stateParentDir)) {
        const subdirs = fs.readdirSync(stateParentDir);
        if (subdirs.length > 0) {
          const stateFile = path.join(stateParentDir, subdirs[0], "state.json");
          if (fs.existsSync(stateFile)) {
            try {
              const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
              if (state.jobs.some((j) => j.status === "running")) {
                isRunning = true;
                break;
              }
            } catch {}
          }
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(isRunning, "Expected job to be in running state");

    // Attempt to resume while delegation is running
    const res = runCompanion(["delegate", "--resume", "should be refused"], {
      pluginDataDir,
      sessionId: "session-a"
    });

    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.includes("Cannot resume while a delegation in this Claude session is running"));
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("resume is refused with clear message while a Delegation of this Claude session is queued", () => {
  const pluginDataDir = makeTempDir("mcode-test-data-");

  // Create an initial completed delegation
  const run1 = runCompanion(["delegate", "initial finished delegation"], {
    pluginDataDir,
    sessionId: "session-a",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(run1.status, 0);

  // Directly set up a queued job in the store
  const stateDir = path.join(pluginDataDir, "state", fs.readdirSync(path.join(pluginDataDir, "state"))[0]);
  const stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const queuedJob = {
    id: "delegate-queued-01",
    kind: "delegate",
    title: "queued delegation",
    status: "queued",
    sessionId: "session-a",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.jobs.unshift(queuedJob);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  fs.writeFileSync(path.join(stateDir, "jobs", `${queuedJob.id}.json`), JSON.stringify(queuedJob, null, 2), "utf8");

  const res = runCompanion(["delegate", "--resume", "should be refused"], {
    pluginDataDir,
    sessionId: "session-a"
  });

  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Cannot resume while a delegation in this Claude session is queued"));
});


