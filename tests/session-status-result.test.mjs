import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir, runCompanion } from "./helpers/run-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");
const HOOK_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/session-start.mjs");
const FAKE_MCODE = path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs");
const FIXTURES_DIR = path.join(ROOT_DIR, "tests/fixtures");

function runSessionStartHook(stdinJson, env = {}) {
  const nodeDir = path.dirname(process.execPath);
  const combinedEnv = {
    ...process.env,
    PATH: `${nodeDir}:/usr/bin:/bin`,
    ...env
  };

  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
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

test("SessionStart hook appends single-quoted exports safe from subshell expansion", () => {
  const pluginDataDir = makeTempDir("mcode-test-hook-data-");
  const envFile = path.join(pluginDataDir, "claude-env.sh");
  fs.writeFileSync(envFile, "# Session env file\n");

  const trickyValue = '/path/with spaces/$(whoami)/`date`/"double\'quotes"';
  const trickySessionId = "session-id'with$(evil)";

  const hookRes = runSessionStartHook(
    { session_id: trickySessionId },
    { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: trickyValue }
  );

  assert.equal(hookRes.status, 0);
  const envContent = fs.readFileSync(envFile, "utf8");
  assert.ok(envContent.includes("export MCODE_CLAUDE_SESSION_ID='session-id'\\''with$(evil)'"));
  assert.ok(envContent.includes(`export MCODE_PLUGIN_DATA='/path/with spaces/$(whoami)/\`date\`/"double'\\''quotes"'`));
  assert.ok(!envContent.includes("export CLAUDE_PLUGIN_DATA="));

  // Sourcing the env file in a subshell recovers byte-identical values without executing $(whoami) or `date`
  const subshell = spawnSync("sh", ["-c", `. "${envFile}" && printf "%s\n%s" "$MCODE_CLAUDE_SESSION_ID" "$MCODE_PLUGIN_DATA"`], {
    encoding: "utf8"
  });
  assert.equal(subshell.status, 0);
  const [recoveredSessionId, recoveredPluginData] = subshell.stdout.split("\n");
  assert.equal(recoveredSessionId, trickySessionId);
  assert.equal(recoveredPluginData, trickyValue);

  // Companion reading MCODE_CLAUDE_SESSION_ID and MCODE_PLUGIN_DATA records Job under that session
  const compRes = runCompanion(["delegate", "--json", "task from hooked session"], {
    pluginDataDir,
    sessionId: trickySessionId,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(compRes.status, 0);
  const parsed = JSON.parse(compRes.stdout);
  assert.equal(parsed.sessionId, trickySessionId);
});

test("companion uses MCODE_PLUGIN_DATA and ignores foreign CLAUDE_PLUGIN_DATA", () => {
  const ourPluginDataDir = makeTempDir("mcode-test-ours-");
  const foreignPluginDataDir = makeTempDir("mcode-test-foreign-");

  const delRes = runCompanion(["delegate", "--json", "task with foreign env present"], {
    pluginDataDir: ourPluginDataDir,
    env: {
      CLAUDE_PLUGIN_DATA: foreignPluginDataDir,
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });
  assert.equal(delRes.status, 0);
  const parsed = JSON.parse(delRes.stdout);

  // Status must find the Job in our directory
  const statusRes = runCompanion(["status", "--json"], {
    pluginDataDir: ourPluginDataDir,
    env: {
      CLAUDE_PLUGIN_DATA: foreignPluginDataDir
    }
  });
  assert.equal(statusRes.status, 0);
  const jobs = JSON.parse(statusRes.stdout);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, parsed.id);

  // The foreign directory must stay completely empty
  const foreignContents = fs.readdirSync(foreignPluginDataDir);
  assert.equal(foreignContents.length, 0, "foreign CLAUDE_PLUGIN_DATA directory must remain empty");
});

test("status splits raw argument string on whitespace", () => {
  const pluginDataDir = makeTempDir("mcode-test-rawargs-");

  const res = runCompanion(["delegate", "--json", "task for raw status args"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);

  // Pass "<id-prefix> --json" as a single raw string
  const prefix = parsed.id.slice(0, 16);
  const statusRes = runCompanion(["status", `${prefix} --json`], { pluginDataDir });
  assert.equal(statusRes.status, 0);
  const statusJson = JSON.parse(statusRes.stdout);
  assert.equal(statusJson.id, parsed.id);
});

test("Job record includes title, process id, and rendered output", () => {
  const pluginDataDir = makeTempDir("mcode-test-job-fields-");

  const res = runCompanion(["delegate", "--json", "investigate latency regression"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);

  assert.equal(parsed.title, "investigate latency regression");
  assert.equal(typeof parsed.processId, "number");
  assert.ok(parsed.processId > 0);
  assert.ok(parsed.renderedOutput.includes("OK"));
  assert.ok(parsed.renderedOutput.includes("mcode session: mvs_e833006d348440b38a85b16f960606ce"));
});

test("status table outputs id, kind, state, age, and progress preview without final completion marker", () => {
  const pluginDataDir = makeTempDir("mcode-test-status-table-");

  const res = runCompanion(["delegate", "first task"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(res.status, 0);

  const statusRes = runCompanion(["status"], { pluginDataDir });
  assert.equal(statusRes.status, 0);
  assert.ok(statusRes.stdout.includes("ID"));
  assert.ok(statusRes.stdout.includes("KIND"));
  assert.ok(statusRes.stdout.includes("STATE"));
  assert.ok(statusRes.stdout.includes("AGE"));
  assert.ok(statusRes.stdout.includes("PROGRESS"));
  assert.ok(statusRes.stdout.includes("delegate"));
  assert.ok(statusRes.stdout.includes("completed"));
  // Preview must be the last non-Completed progress line
  assert.ok(statusRes.stdout.includes("Responding..."));
  assert.ok(!statusRes.stdout.includes("Completed with status"));
});

test("status for a single Job displays details and recent progress lines", () => {
  const pluginDataDir = makeTempDir("mcode-test-single-job-");

  const delRes = runCompanion(["delegate", "--json", "single job status test"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(delRes.status, 0);
  const job = JSON.parse(delRes.stdout);

  // Text view
  const statusRes = runCompanion(["status", job.id], { pluginDataDir });
  assert.equal(statusRes.status, 0);
  assert.ok(statusRes.stdout.includes(`Job ID:         ${job.id}`));
  assert.ok(statusRes.stdout.includes("Recent progress:"));
  assert.ok(statusRes.stdout.includes("Starting delegation: \"single job status test\""));

  // JSON view
  const statusJsonRes = runCompanion(["status", job.id, "--json"], { pluginDataDir });
  assert.equal(statusJsonRes.status, 0);
  const statusJson = JSON.parse(statusJsonRes.stdout);
  assert.equal(statusJson.id, job.id);
  assert.equal(statusJson.status, "completed");
  assert.ok(Array.isArray(statusJson.progress));
  assert.ok(statusJson.progress.length > 0);
});

test("status rejects unsupported options with clear message", () => {
  const res = runCompanion(["status", "--bogus-flag"]);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Unsupported option: --bogus-flag"));
  assert.ok(res.stderr.includes("Supported options: --all, --json"));
});

test("result defaults to the most recent finished Job of the session", () => {
  const pluginDataDir = makeTempDir("mcode-test-result-default-");

  runCompanion(["delegate", "older job"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  runCompanion(["delegate", "newer job"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  const res = runCompanion(["result"], { pluginDataDir });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("OK"));
  assert.ok(res.stdout.includes("mcode session:"));

  const resJson = runCompanion(["result", "--json"], { pluginDataDir });
  assert.equal(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.title, "newer job");
  assert.equal(parsed.status, "completed");
});

test("result with Job id prints that specific Job output", () => {
  const pluginDataDir = makeTempDir("mcode-test-result-id-");

  const delRes = runCompanion(["delegate", "--json", "specific job target"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  const job = JSON.parse(delRes.stdout);

  const res = runCompanion(["result", job.id], { pluginDataDir });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("OK"));

  const resJson = runCompanion(["result", job.id, "--json"], { pluginDataDir });
  assert.equal(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.id, job.id);
  assert.equal(parsed.title, "specific job target");
});

test("result reports error when target Job is still running", (t) => {
  const pluginDataDir = makeTempDir("mcode-test-running-");
  const binDir = makeTempDir("mcode-test-bin-");

  const symlinkPath = path.join(binDir, "mcode");
  try {
    fs.symlinkSync(FAKE_MCODE, symlinkPath);
  } catch {
    fs.copyFileSync(FAKE_MCODE, symlinkPath);
    fs.chmodSync(symlinkPath, 0o755);
  }

  const child = spawn(process.execPath, [COMPANION_SCRIPT, "delegate", "long running task"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      MCODE_PLUGIN_DATA: pluginDataDir,
      MCODE_CLAUDE_SESSION_ID: "test-running-session",
      MCODE_SLEEP_MS: "5000",
      MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl")
    }
  });

  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  });

  let runningJobId = null;
  const start = Date.now();
  while (Date.now() - start < 3000) {
    try {
      const stateDirs = fs.readdirSync(path.join(pluginDataDir, "state"));
      if (stateDirs.length > 0) {
        const stateFile = path.join(pluginDataDir, "state", stateDirs[0], "state.json");
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          if (state.jobs.length > 0 && state.jobs[0].status === "running") {
            runningJobId = state.jobs[0].id;
            break;
          }
        }
      }
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(runningJobId, "Job record should be created with status running");

  const res = runCompanion(["result", runningJobId], {
    pluginDataDir,
    sessionId: "test-running-session"
  });

  child.kill("SIGKILL");

  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes(`Job ${runningJobId} is not finished (status: running)`));
});

test("result accepts --all to read finished Job from another session by id", () => {
  const pluginDataDir = makeTempDir("mcode-test-result-all-");

  // Session A creates Job A
  const jobARes = runCompanion(["delegate", "--json", "task from session A"], {
    pluginDataDir,
    sessionId: "session-A",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(jobARes.status, 0);
  const jobA = JSON.parse(jobARes.stdout);

  // In Session B, result jobA.id without --all fails
  const resWithoutAll = runCompanion(["result", jobA.id], {
    pluginDataDir,
    sessionId: "session-B"
  });
  assert.notEqual(resWithoutAll.status, 0);
  assert.ok(resWithoutAll.stderr.includes(`No Job found matching "${jobA.id}"`));

  // In Session B, result jobA.id --all succeeds
  const resWithAll = runCompanion(["result", jobA.id, "--all"], {
    pluginDataDir,
    sessionId: "session-B"
  });
  assert.equal(resWithAll.status, 0);
  assert.ok(resWithAll.stdout.includes("OK"));
});

test("result rejects unsupported options with clear message", () => {
  const res = runCompanion(["result", "--bogus-flag"]);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Unsupported option: --bogus-flag"));
  assert.ok(res.stderr.includes("Supported options: --all, --json"));
});

test("result with no finished jobs exits with clear error", () => {
  const pluginDataDir = makeTempDir("mcode-test-result-empty-");
  const res = runCompanion(["result"], { pluginDataDir });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("No finished Jobs found for this session"));
});

test("Job ids resolve by unique prefix, ambiguous prefix lists candidates, unknown id gives clear error", () => {
  const pluginDataDir = makeTempDir("mcode-test-prefix-");

  const job1Res = runCompanion(["delegate", "--json", "prefix job 1"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  const job1 = JSON.parse(job1Res.stdout);

  const job2Res = runCompanion(["delegate", "--json", "prefix job 2"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  const job2 = JSON.parse(job2Res.stdout);

  // Unique prefix resolution
  const uniquePrefix = job1.id;
  const resUnique = runCompanion(["status", uniquePrefix, "--json"], { pluginDataDir });
  assert.equal(resUnique.status, 0);
  const parsedUnique = JSON.parse(resUnique.stdout);
  assert.equal(parsedUnique.id, job1.id);

  // Ambiguous prefix (both start with "delegate-")
  const resAmbiguous = runCompanion(["status", "delegate-"], { pluginDataDir });
  assert.notEqual(resAmbiguous.status, 0);
  assert.ok(resAmbiguous.stderr.includes("Ambiguous Job ID prefix \"delegate-\""));
  assert.ok(resAmbiguous.stderr.includes(job1.id));
  assert.ok(resAmbiguous.stderr.includes(job2.id));

  // Unknown prefix
  const resUnknown = runCompanion(["status", "nonexistent-job-id"], { pluginDataDir });
  assert.notEqual(resUnknown.status, 0);
  assert.ok(resUnknown.stderr.includes("No Job found matching \"nonexistent-job-id\""));
});

test("two Claude session ids in the same workspace do not see each other's Jobs unless --all", () => {
  const pluginDataDir = makeTempDir("mcode-test-sessions-");

  // Session A creates Job A
  const jobARes = runCompanion(["delegate", "--json", "task in session A"], {
    pluginDataDir,
    sessionId: "claude-session-alpha",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(jobARes.status, 0);
  const jobA = JSON.parse(jobARes.stdout);

  // Session B creates Job B
  const jobBRes = runCompanion(["delegate", "--json", "task in session B"], {
    pluginDataDir,
    sessionId: "claude-session-beta",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(jobBRes.status, 0);
  const jobB = JSON.parse(jobBRes.stdout);

  // Session B runs status --json (without --all)
  const statusB = runCompanion(["status", "--json"], {
    pluginDataDir,
    sessionId: "claude-session-beta"
  });
  assert.equal(statusB.status, 0);
  const parsedB = JSON.parse(statusB.stdout);
  assert.equal(parsedB.length, 1);
  assert.equal(parsedB[0].id, jobB.id);

  // Session B cannot view Job A by id without --all
  const singleStatusB = runCompanion(["status", jobA.id], {
    pluginDataDir,
    sessionId: "claude-session-beta"
  });
  assert.notEqual(singleStatusB.status, 0);
  assert.ok(singleStatusB.stderr.includes(`No Job found matching "${jobA.id}"`));

  // Session B runs status --all --json
  const statusAll = runCompanion(["status", "--all", "--json"], {
    pluginDataDir,
    sessionId: "claude-session-beta"
  });
  assert.equal(statusAll.status, 0);
  const parsedAll = JSON.parse(statusAll.stdout);
  assert.equal(parsedAll.length, 2);
  const ids = parsedAll.map((j) => j.id);
  assert.ok(ids.includes(jobA.id));
  assert.ok(ids.includes(jobB.id));

  // Session B can view Job A by id with --all
  const singleStatusBAll = runCompanion(["status", jobA.id, "--all"], {
    pluginDataDir,
    sessionId: "claude-session-beta"
  });
  assert.equal(singleStatusBAll.status, 0);
  assert.ok(singleStatusBAll.stdout.includes(`Job ID:         ${jobA.id}`));
});

test("index bounded at 50 (newest first), pruned records' files removed", () => {
  const pluginDataDir = makeTempDir("mcode-test-bounded-");
  const jobIds = [];

  // Create 52 jobs sequentially through companion
  for (let i = 1; i <= 52; i += 1) {
    const res = runCompanion(["delegate", "--json", `batch job ${i}`], {
      pluginDataDir,
      env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    jobIds.push(parsed.id);
  }

  // Listing --all should have exactly 50 entries
  const statusRes = runCompanion(["status", "--all", "--json"], { pluginDataDir });
  assert.equal(statusRes.status, 0);
  const listedJobs = JSON.parse(statusRes.stdout);
  assert.equal(listedJobs.length, 50);

  // Newest job (52nd) is first in the list
  assert.equal(listedJobs[0].id, jobIds[51]);

  // Oldest jobs (1st and 2nd) are pruned
  const listedIds = new Set(listedJobs.map((j) => j.id));
  assert.ok(!listedIds.has(jobIds[0]), "Job 1 should have been pruned");
  assert.ok(!listedIds.has(jobIds[1]), "Job 2 should have been pruned");

  // Querying pruned job 1 fails because its record and log files were removed
  const queryPrunedRes = runCompanion(["status", jobIds[0], "--all"], { pluginDataDir });
  assert.notEqual(queryPrunedRes.status, 0);
  assert.ok(queryPrunedRes.stderr.includes(`No Job found matching "${jobIds[0]}"`));

  // Count files in Job store's jobs directory to prove pruned records' files are deleted
  const stateDirs = fs.readdirSync(path.join(pluginDataDir, "state"));
  const jobsDir = path.join(pluginDataDir, "state", stateDirs[0], "jobs");
  const files = fs.readdirSync(jobsDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const logFiles = files.filter((f) => f.endsWith(".log"));
  assert.equal(jsonFiles.length, 50);
  assert.equal(logFiles.length, 50);
  assert.ok(!fs.existsSync(path.join(jobsDir, `${jobIds[0]}.json`)));
  assert.ok(!fs.existsSync(path.join(jobsDir, `${jobIds[0]}.log`)));
});
