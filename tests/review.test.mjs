import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir, runCompanion } from "./helpers/run-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function initTestRepo() {
  const dir = makeTempDir("mcode-review-test-");
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "math.js"), "function add(a, b) { return a + b; }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

test("review rejects unsupported options with clear message", () => {
  const repo = initTestRepo();
  const res = runCompanion(["review", "--base", "main"], { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unsupported option: --base/);
  assert.match(res.stderr, /--wait/);
  assert.match(res.stderr, /--background/);
  assert.match(res.stderr, /--json/);
  assert.equal(res.recordedArgv, null, "mcode must not be called when options are invalid");
});

test("review rejects unexpected positional arguments", () => {
  const repo = initTestRepo();
  const res = runCompanion(["review", "extra-arg"], { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unexpected argument: "extra-arg"/);
  assert.equal(res.recordedArgv, null, "mcode must not be called on unexpected arguments");
});

test("review rejects --wait combined with --background", () => {
  const repo = initTestRepo();
  const res = runCompanion(["review", "--wait", "--background"], { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Cannot combine --wait and --background/);
  assert.equal(res.recordedArgv, null, "mcode must not be called when incompatible options are passed");
});

test("review outside git repository exits with error and does not call mcode", () => {
  const nonGitDir = makeTempDir("mcode-non-git-");
  const res = runCompanion(["review"], { cwd: nonGitDir });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Not a git repository/i);
  assert.equal(res.recordedArgv, null, "mcode must not be called outside git repo");
});

test("review on clean working tree short-circuits without calling mcode", () => {
  const repo = initTestRepo();
  const res = runCompanion(["review"], { cwd: repo });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /No uncommitted changes to review\./);
  assert.equal(res.recordedArgv, null, "mcode must not be called when working tree is clean");
});

test("review on clean working tree with --json returns structured message without calling mcode", () => {
  const repo = initTestRepo();
  const res = runCompanion(["review", "--json"], { cwd: repo });
  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.hasChanges, false);
  assert.match(data.message, /No uncommitted changes to review\./);
  assert.equal(res.recordedArgv, null, "mcode must not be called when working tree is clean");
});

test("review invokes mcode with correct argv: exec review --cwd <toplevel> --permission smart --output-format stream-json", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const res = runCompanion(["review"], { cwd: repo });
  assert.equal(res.status, 0);

  const realRepo = fs.realpathSync(repo);
  assert.deepEqual(res.recordedArgv, [
    "exec",
    "review",
    "--cwd",
    realRepo,
    "--permission",
    "smart",
    "--output-format",
    "stream-json"
  ]);
});

test("review runs from a subdirectory using git toplevel for --cwd and stores Job with kind review", () => {
  const repo = initTestRepo();
  const subDir = path.join(repo, "src/sub");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const res = runCompanion(["review", "--json"], { cwd: subDir });
  assert.equal(res.status, 0);

  const realRepo = fs.realpathSync(repo);
  assert.deepEqual(res.recordedArgv, [
    "exec",
    "review",
    "--cwd",
    realRepo,
    "--permission",
    "smart",
    "--output-format",
    "stream-json"
  ]);

  const payload = JSON.parse(res.stdout);
  assert.equal(payload.kind, "review");
  assert.ok(payload.id.startsWith("review-"), `Expected review- prefix, got ${payload.id}`);
  assert.equal(payload.status, "completed");
  assert.equal(payload.readOnly, true);
});

test("review renders real findings verbatim and appends session footer", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/review-needs-changes.stream.jsonl");
  const res = runCompanion(["review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Verdict: needs_changes/m);
  assert.match(res.stdout, /add 函数返回减法结果/);
  assert.match(res.stdout, /math\.js:3/);
  assert.match(res.stdout, /---\nmcode session: mvs_599cb59c885d43558d9fb53967496207/);
  assert.match(res.stdout, /To open this session in the mcode TUI: mcode --session mvs_599cb59c885d43558d9fb53967496207/);
});

test("review clean pass renders summary and session footer", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a + b; }\nfunction multiply(a, b) { return a * b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/review-pass.stream.jsonl");
  const res = runCompanion(["review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Verdict: pass/m);
  assert.match(res.stdout, /本次未发现可报告的问题/);
  assert.match(res.stdout, /---\nmcode session: mvs_9e4dbc34c4284eeca730d9fa521028a0/);
});

test("review falls back to formatted JSON when output object has no verdict, summary, or findings", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const customFixtureDir = makeTempDir("mcode-custom-output-");
  const streamFile = path.join(customFixtureDir, "custom.stream.jsonl");
  const lines = [
    JSON.stringify({ schemaVersion: 1, sequence: 1, type: "exec.started" }),
    JSON.stringify({
      schemaVersion: 1,
      sequence: 2,
      type: "exec.completed",
      result: {
        schemaVersion: 1,
        type: "exec.result",
        status: "succeeded",
        output: { customMetric: 42, details: "arbitrary object" }
      }
    })
  ];
  fs.writeFileSync(streamFile, lines.join("\n") + "\n", "utf8");

  const res = runCompanion(["review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: streamFile }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /"customMetric": 42/);
});

test("review --wait runs in foreground and prints result", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/review-needs-changes.stream.jsonl");
  const res = runCompanion(["review", "--wait"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Verdict: needs_changes/m);
  assert.match(res.stdout, /add 函数返回减法结果/);
  assert.match(res.stdout, /---\nmcode session: mvs_599cb59c885d43558d9fb53967496207/);
});

test("review --background writes queued Job, prints guidance, and worker executes in background", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/review-needs-changes.stream.jsonl");
  const res = runCompanion(["review", "--background"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Job (review-[a-z0-9-]+) started in the background\./);
  const match = res.stdout.match(/Job (review-[a-z0-9-]+) started in the background\./);
  const jobId = match[1];

  // Wait for worker to finish using status --wait
  const waitRes = runCompanion(["status", jobId, "--wait", "--timeout-ms", "5000"], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });

  assert.equal(waitRes.status, 0);
  assert.match(waitRes.stdout, /State:\s+completed/);
  assert.match(waitRes.stdout, /Kind:\s+review/);

  // Result prints the findings verbatim
  const resultRes = runCompanion(["result", jobId], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });

  assert.equal(resultRes.status, 0);
  assert.match(resultRes.stdout, /^Verdict: needs_changes/m);
  assert.match(resultRes.stdout, /add 函数返回减法结果/);
  assert.match(resultRes.stdout, /---\nmcode session: mvs_599cb59c885d43558d9fb53967496207/);
});

test("cancel terminates running review worker", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const bgRes = runCompanion(["review", "--background"], {
    cwd: repo,
    env: { MCODE_SLEEP_MS: "3000" }
  });

  assert.equal(bgRes.status, 0);
  const match = bgRes.stdout.match(/Job (review-[a-z0-9-]+) started in the background\./);
  const jobId = match[1];

  // Give worker a moment to start
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);

  const cancelRes = runCompanion(["cancel", jobId], {
    cwd: repo,
    pluginDataDir: bgRes.pluginDataDir
  });

  assert.equal(cancelRes.status, 0);
  assert.match(cancelRes.stdout, new RegExp(`Cancelled Job ${jobId}`));

  const statusRes = runCompanion(["status", jobId], {
    cwd: repo,
    pluginDataDir: bgRes.pluginDataDir
  });

  assert.match(statusRes.stdout, /State:\s+cancelled/);
});

test("read-only guard detects modifications during review, renders violation first, and does not revert changes", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const res = runCompanion(["review"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "modify", path: "math.js", content: "mutated during review\n" }
      ])
    }
  });

  assert.equal(res.status, 0);
  assert.ok(
    res.stdout.startsWith("Read-only violation: files were modified during a read-only review:"),
    `Expected violation header for review, got:\n${res.stdout}`
  );
  assert.ok(res.stdout.includes("math.js"));

  const content = fs.readFileSync(path.join(repo, "math.js"), "utf8");
  assert.equal(content, "mutated during review\n");
});

test("review Job appears in status and result with no id returns it", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/review-needs-changes.stream.jsonl");
  const runRes = runCompanion(["review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });
  assert.equal(runRes.status, 0);

  const statusRes = runCompanion(["status"], {
    cwd: repo,
    pluginDataDir: runRes.pluginDataDir
  });
  assert.equal(statusRes.status, 0);
  assert.match(statusRes.stdout, /review/);
  assert.match(statusRes.stdout, /completed/);

  const resultRes = runCompanion(["result"], {
    cwd: repo,
    pluginDataDir: runRes.pluginDataDir
  });
  assert.equal(resultRes.status, 0);
  assert.match(resultRes.stdout, /^Verdict: needs_changes/m);
  assert.match(resultRes.stdout, /add 函数返回减法结果/);
});

test("finished review Job is never a resume-candidate and running review Job does not block delegate --resume", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/review-needs-changes.stream.jsonl");
  const reviewRes = runCompanion(["review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });
  assert.equal(reviewRes.status, 0);

  // Finished review job must not be a resume candidate
  const candidateRes = runCompanion(["resume-candidate", "--json"], {
    cwd: repo,
    pluginDataDir: reviewRes.pluginDataDir
  });
  assert.equal(candidateRes.status, 0);
  const candidateData = JSON.parse(candidateRes.stdout);
  assert.equal(candidateData.hasCandidate, false);

  // Create a previous finished delegate Job that has an mcode session id
  const delegate1 = runCompanion(["delegate", "first task"], {
    cwd: repo,
    pluginDataDir: reviewRes.pluginDataDir
  });
  assert.equal(delegate1.status, 0);

  // Start a review Job running in the background
  const bgReview = runCompanion(["review", "--background"], {
    cwd: repo,
    pluginDataDir: reviewRes.pluginDataDir,
    env: { MCODE_SLEEP_MS: "3000" }
  });
  assert.equal(bgReview.status, 0);

  // delegate --resume must NOT be blocked by running/queued review Job
  const resumeRes = runCompanion(["delegate", "--resume", "followup task"], {
    cwd: repo,
    pluginDataDir: reviewRes.pluginDataDir
  });
  assert.equal(resumeRes.status, 0);

  // Clean up running background review job
  const match = bgReview.stdout.match(/Job (review-[a-z0-9-]+) started in the background\./);
  if (match) {
    runCompanion(["cancel", match[1]], { cwd: repo, pluginDataDir: reviewRes.pluginDataDir });
  }
});

test('review command invocation with background flag and empty arguments: ["review", "--background", ""]', () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/review-needs-changes.stream.jsonl");
  const res = runCompanion(["review", "--background", ""], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Job (review-[a-z0-9-]+) started in the background\./);
  const match = res.stdout.match(/Job (review-[a-z0-9-]+) started in the background\./);
  const jobId = match[1];

  const waitRes = runCompanion(["status", jobId, "--wait", "--timeout-ms", "5000"], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });
  assert.equal(waitRes.status, 0);
  assert.match(waitRes.stdout, /State:\s+completed/);
  assert.match(waitRes.stdout, /Kind:\s+review/);
});
