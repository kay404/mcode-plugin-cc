import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");
const HOOK_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/session-start.mjs");
const FAKE_MCODE = path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs");
const FIXTURES_DIR = path.join(ROOT_DIR, "tests/fixtures");

function runCompanion(args, options = {}) {
  const pluginDataDir = options.pluginDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-data-"));
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

  const nodeDir = path.dirname(process.execPath);
  const combinedEnv = {
    ...process.env,
    PATH: options.noMcodeOnPath ? `${nodeDir}:/usr/bin:/bin` : `${binDir}:${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    MCODE_CLAUDE_SESSION_ID: options.sessionId ?? "test-session-001",
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

  return { status, stdout, stderr, error, pluginDataDir };
}

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

test("SessionStart hook appends exports to CLAUDE_ENV_FILE and companion scopes Jobs by that session id", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-hook-data-"));
  const envFile = path.join(pluginDataDir, "claude-env.sh");
  fs.writeFileSync(envFile, "# Session env file\n");

  const hookRes = runSessionStartHook(
    { session_id: "claude-session-from-hook-99" },
    { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginDataDir }
  );

  assert.equal(hookRes.status, 0);
  const envContent = fs.readFileSync(envFile, "utf8");
  assert.ok(envContent.includes('export MCODE_CLAUDE_SESSION_ID="claude-session-from-hook-99"'));
  assert.ok(envContent.includes(`export CLAUDE_PLUGIN_DATA="${pluginDataDir}"`));

  // Companion reading MCODE_CLAUDE_SESSION_ID records Job under that session
  const compRes = runCompanion(["delegate", "--json", "task from hooked session"], {
    pluginDataDir,
    sessionId: "claude-session-from-hook-99",
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });

  assert.equal(compRes.status, 0);
  const parsed = JSON.parse(compRes.stdout);
  assert.equal(parsed.sessionId, "claude-session-from-hook-99");
});

test("raw argument string re-splits: keeps apostrophe inside word literal (don't is one word)", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-rawargs-"));

  // Pass single raw argument string containing options, quotes, and "don't"
  const res = runCompanion(["delegate", '--json "don\'t break the build"'], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl") }
  });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.prompt, "don't break the build");

  // Call status passing raw argument string with quotes around job id
  const statusRes = runCompanion(["status", `"${parsed.id}"`], {
    pluginDataDir
  });
  assert.equal(statusRes.status, 0);
  assert.ok(statusRes.stdout.includes(parsed.id));
  assert.ok(statusRes.stdout.includes("don't break the build"));
});

test("raw argument string re-splits: unterminated quote is an error", () => {
  const res = runCompanion(["status", '--all "unterminated quote']);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Unterminated quote"));
});

test("Job record includes title, process id, and rendered output", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-job-fields-"));

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

test("status table outputs id, kind, state, age, and progress preview", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-status-table-"));

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
});

test("status for a single Job displays details and recent progress lines", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-single-job-"));

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
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-result-default-"));

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
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-result-id-"));

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

test("result rejects unsupported options with clear message", () => {
  const res = runCompanion(["result", "--all"]);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Unsupported option: --all"));
  assert.ok(res.stderr.includes("Supported options: --json"));
});

test("result with no finished jobs exits with clear error", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-result-empty-"));
  const res = runCompanion(["result"], { pluginDataDir });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("No finished Jobs found for this session"));
});

test("Job ids resolve by unique prefix, ambiguous prefix lists candidates, unknown id gives clear error", () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-prefix-"));

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

  // Unique prefix resolution (e.g. full id or unambiguous prefix)
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
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-sessions-"));

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
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-bounded-"));
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
});
