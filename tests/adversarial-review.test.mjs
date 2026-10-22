import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir, runCompanion } from "./helpers/run-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function initTestRepo() {
  const dir = makeTempDir("mcode-adv-test-");
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "math.js"), "function add(a, b) { return a + b; }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

test("adversarial-review rejects unknown flags with clear error listing supported ones", () => {
  const repo = initTestRepo();
  const res = runCompanion(["adversarial-review", "--unknown-flag"], { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unsupported option: --unknown-flag/);
  assert.match(res.stderr, /--base <ref>/);
  assert.match(res.stderr, /--plan <path>/);
  assert.match(res.stderr, /--wait/);
  assert.match(res.stderr, /--background/);
  assert.match(res.stderr, /--json/);
  assert.equal(res.recordedArgv, null, "mcode must not be called on unknown option");
});

test("adversarial-review rejects mutually exclusive --base and --plan", () => {
  const repo = initTestRepo();
  const res = runCompanion(["adversarial-review", "--base", "main", "--plan", "plan.md"], { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Cannot combine --base and --plan/);
  assert.equal(res.recordedArgv, null, "mcode must not be called");
});

test("adversarial-review rejects mutually exclusive --wait and --background", () => {
  const repo = initTestRepo();
  const res = runCompanion(["adversarial-review", "--wait", "--background"], { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Cannot combine --wait and --background/);
  assert.equal(res.recordedArgv, null, "mcode must not be called");
});

test("adversarial-review rejects missing value for --base and --plan", () => {
  const repo = initTestRepo();
  const resBase = runCompanion(["adversarial-review", "--base"], { cwd: repo });
  assert.equal(resBase.status, 1);
  assert.match(resBase.stderr, /Missing value for --base/);

  const resPlan = runCompanion(["adversarial-review", "--plan"], { cwd: repo });
  assert.equal(resPlan.status, 1);
  assert.match(resPlan.stderr, /Missing value for --plan/);
});

test("working tree outside git repository exits with error and does not call mcode", () => {
  const nonGitDir = makeTempDir("mcode-adv-non-git-");
  const res = runCompanion(["adversarial-review"], { cwd: nonGitDir });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Not a git repository/i);
  assert.equal(res.recordedArgv, null, "mcode must not be called outside git repo");
});

test("working tree with clean changes short-circuits without calling mcode", () => {
  const repo = initTestRepo();
  const res = runCompanion(["adversarial-review"], { cwd: repo });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /No uncommitted changes to review\./);
  assert.equal(res.recordedArgv, null, "mcode must not be called when working tree is clean");
});

test("working tree with clean changes in --json mode returns structured message without calling mcode", () => {
  const repo = initTestRepo();
  const res = runCompanion(["adversarial-review", "--json"], { cwd: repo });
  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.hasChanges, false);
  assert.match(data.message, /No uncommitted changes to review\./);
  assert.equal(res.recordedArgv, null, "mcode must not be called when working tree is clean");
});

test("branch target outside git repository exits with error and does not call mcode", () => {
  const nonGitDir = makeTempDir("mcode-adv-non-git-");
  const res = runCompanion(["adversarial-review", "--base", "main"], { cwd: nonGitDir });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Not a git repository/i);
  assert.equal(res.recordedArgv, null, "mcode must not be called outside git repo");
});

test("branch target with invalid base ref reports clear error and does not call mcode", () => {
  const repo = initTestRepo();
  const res = runCompanion(["adversarial-review", "--base", "non-existent-ref-12345"], { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Invalid base ref: "non-existent-ref-12345"/);
  assert.equal(res.recordedArgv, null, "mcode must not be called on invalid ref");
});

test("branch target with empty diff short-circuits without calling mcode", () => {
  const repo = initTestRepo();
  // No commits between main and HEAD
  const res = runCompanion(["adversarial-review", "--base", "main"], { cwd: repo });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /No changes between main and HEAD\./);
  assert.equal(res.recordedArgv, null, "mcode must not be called when branch diff is empty");
});

test("branch target with empty diff in --json mode returns structured message without calling mcode", () => {
  const repo = initTestRepo();
  const res = runCompanion(["adversarial-review", "--base", "main", "--json"], { cwd: repo });
  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.hasChanges, false);
  assert.match(data.message, /No changes between main and HEAD\./);
  assert.equal(res.recordedArgv, null, "mcode must not be called when branch diff is empty");
});

test("missing plan file reports clear error and does not call mcode", () => {
  const nonGitDir = makeTempDir("mcode-adv-plan-missing-");
  const res = runCompanion(["adversarial-review", "--plan", "does-not-exist.md"], { cwd: nonGitDir });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Plan file "does-not-exist\.md" not found or unreadable/);
  assert.equal(res.recordedArgv, null, "mcode must not be called when plan file is missing");
});

test("plan outside git repo is allowed and reports 'could not check' guard notice", () => {
  const nonGitDir = makeTempDir("mcode-adv-plan-outside-");
  const planPath = path.join(nonGitDir, "design.md");
  fs.writeFileSync(planPath, "# Test Plan\n\nSome design content\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-plan.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--plan", "design.md"], {
    cwd: nonGitDir,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Read-only check could not run: not a git repository\./);
  assert.match(res.stdout, /^Verdict: needs-attention/m);
  assert.ok(res.recordedArgv.includes("--output-schema"));
});

test("working tree target: correct argv, smart permission, cwd = git toplevel, prompt on stdin", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review", "focus on edge cases"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  const realRepo = fs.realpathSync(repo);
  const argv = res.recordedArgv;

  assert.equal(argv[0], "exec");
  assert.equal(argv[argv.indexOf("--cwd") + 1], realRepo);
  assert.equal(argv[argv.indexOf("--permission") + 1], "smart");
  assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
  assert.ok(argv.includes("--output-schema"));
  const schemaArg = argv[argv.indexOf("--output-schema") + 1];
  assert.ok(path.isAbsolute(schemaArg), "output-schema must be an absolute path");
  assert.ok(schemaArg.endsWith("adversarial-review.json"));

  assert.ok(res.recordedStdin, "prompt must be sent on stdin");
  assert.match(res.recordedStdin, /Working tree uncommitted changes/);
  assert.match(res.recordedStdin, /focus on edge cases/);
  assert.match(res.recordedStdin, /math\.js/);
});

test("branch target: correct argv and stdin prompt", () => {
  const repo = initTestRepo();
  execFileSync("git", ["checkout", "-b", "feature/my-branch"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "calc.js"), "export function divide(a, b) { return a / b; }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "feature commit"], { cwd: repo });

  const fixture = path.join(__dirname, "fixtures/adversarial-review-branch.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--base", "main", "check division by zero"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.ok(res.recordedArgv.includes("--output-schema"));
  assert.equal(res.recordedArgv[res.recordedArgv.indexOf("--permission") + 1], "smart");

  assert.ok(res.recordedStdin);
  assert.match(res.recordedStdin, /Branch changes compared to base 'main'/);
  assert.match(res.recordedStdin, /check division by zero/);
  assert.match(res.recordedStdin, /calc\.js/);
});

test("plan target: correct argv and stdin prompt", () => {
  const repo = initTestRepo();
  const planPath = path.join(repo, "architecture.md");
  fs.writeFileSync(planPath, "# Migration Plan\n\nMigrate auth service\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-plan.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--plan", "architecture.md", "focus on rollback"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.ok(res.recordedArgv.includes("--output-schema"));
  assert.match(res.recordedStdin, /Plan document: architecture\.md/);
  assert.match(res.recordedStdin, /focus on rollback/);
  assert.match(res.recordedStdin, /Migrate auth service/);
});

test("focus text containing --base does not change the target", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review", "check", "--base", "handling"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  // Target must remain working tree, not branch
  assert.match(res.recordedStdin, /Working tree uncommitted changes/);
  assert.match(res.recordedStdin, /check --base handling/);
});

test("untracked files in working-tree mode are covered", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "new-file.js"), "const secret = '12345';\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.recordedStdin, /new-file\.js/);
  assert.match(res.recordedStdin, /secret = '12345'/);
});

test("inline vs collected diff: small diff is inlined in prompt", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.recordedStdin, /Tracked changes diff:/);
  assert.match(res.recordedStdin, /--- a\/math\.js/);
  assert.match(res.recordedStdin, /\+function add\(a, b\) \{ return a - b; \}/);
});

test("inline vs collected diff: large diff (>2000 lines) instructs mcode to collect", () => {
  const repo = initTestRepo();
  const largeContent = Array.from({ length: 2500 }, (_, i) => `const x_${i} = ${i};`).join("\n") + "\n";
  fs.writeFileSync(path.join(repo, "math.js"), largeContent, "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.recordedStdin, /Changes exceed inline threshold/);
  assert.match(res.recordedStdin, /git diff HEAD/);
  assert.match(res.recordedStdin, /math\.js/);
  // Full diff must not be embedded
  assert.ok(!res.recordedStdin.includes("const x_2400 = 2400;"));
});

test("inline vs collected diff: large branch diff instructs mcode to collect", () => {
  const repo = initTestRepo();
  execFileSync("git", ["checkout", "-b", "feature/big-diff"], { cwd: repo });
  const largeContent = Array.from({ length: 2500 }, (_, i) => `const y_${i} = ${i};`).join("\n") + "\n";
  fs.writeFileSync(path.join(repo, "calc.js"), largeContent, "utf8");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "large feature"], { cwd: repo });

  const fixture = path.join(__dirname, "fixtures/adversarial-review-branch.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--base", "main"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.recordedStdin, /Changes exceed inline threshold/);
  assert.match(res.recordedStdin, /git diff main\.\.\.HEAD/);
  assert.ok(!res.recordedStdin.includes("const y_2400 = 2400;"));
});

test("inline vs collected diff: large plan file is referenced by absolute path", () => {
  const repo = initTestRepo();
  const planPath = path.join(repo, "huge-plan.md");
  const largeContent = Array.from({ length: 2500 }, (_, i) => `## Step ${i}\nDo step ${i}\n`).join("\n");
  fs.writeFileSync(planPath, largeContent, "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-plan.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--plan", "huge-plan.md"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.recordedStdin, /Plan document exceeds inline threshold/);
  assert.match(res.recordedStdin, new RegExp(planPath));
  assert.ok(!res.recordedStdin.includes("Do step 2400"));
});

test("valid result rendered in severity order with exact locations and next steps", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);

  // Verdict line first
  assert.ok(res.stdout.startsWith("Verdict: needs-attention\n"));

  // Check severity order: critical must appear before high, high before low
  const criticalIdx = res.stdout.indexOf("[critical]");
  const highIdx = res.stdout.indexOf("[high]");
  const lowIdx = res.stdout.indexOf("[low]");

  assert.ok(criticalIdx !== -1, "Expected [critical] finding");
  assert.ok(highIdx !== -1, "Expected [high] finding");
  assert.ok(lowIdx !== -1, "Expected [low] finding");
  assert.ok(criticalIdx < highIdx, "[critical] must appear before [high]");
  assert.ok(highIdx < lowIdx, "[high] must appear before [low]");

  // Check exact location format file:line_start-line_end
  assert.match(res.stdout, /auth\.js:1-3/);
  assert.match(res.stdout, /auth\.js:2-2/);

  // Check confidence
  assert.match(res.stdout, /Confidence:\s+0\.98/);

  // Check Next steps list
  assert.match(res.stdout, /Next steps:\n- /);

  // Check session footer
  assert.match(res.stdout, /---\nmcode session: mvs_ec1ab9d51f3649b8a56d2c4a5b34589a/);
});

test("schema-invalid fails the Job with the schema-invalid heading", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-schema-invalid.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 1);
  assert.match(res.stdout, /mcode adversarial review output did not match the required schema\./);
  assert.ok(!res.stdout.includes("Verdict:"));
});

test("read-only violation detected during adversarial review, rendered first", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: {
      MCODE_FIXTURE: fixture,
      MCODE_MUTATIONS: JSON.stringify([
        { action: "modify", path: "math.js", content: "mutated during adversarial review\n" }
      ])
    }
  });

  assert.equal(res.status, 0);
  assert.ok(
    res.stdout.startsWith("Read-only violation: files were modified during a read-only adversarial review:"),
    `Expected violation header for adversarial review, got:\n${res.stdout}`
  );
  assert.ok(res.stdout.includes("math.js"));

  const content = fs.readFileSync(path.join(repo, "math.js"), "utf8");
  assert.equal(content, "mutated during adversarial review\n");
});

test("adversarial-review --background writes queued Job, prints guidance, and worker executes in background", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--background"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const match = res.stdout.match(/Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const jobId = match[1];

  // Wait for worker to finish using status --wait
  const waitRes = runCompanion(["status", jobId, "--wait", "--timeout-ms", "5000"], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });

  assert.equal(waitRes.status, 0);
  assert.match(waitRes.stdout, /State:\s+completed/);
  assert.match(waitRes.stdout, /Kind:\s+adversarial-review/);

  // Result prints the findings verbatim
  const resultRes = runCompanion(["result", jobId], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });

  assert.equal(resultRes.status, 0);
  assert.match(resultRes.stdout, /^Verdict: needs-attention/m);
  assert.match(resultRes.stdout, /\[critical\]/);
  assert.match(resultRes.stdout, /Next steps:/);
});

test("cancel terminates running adversarial review worker", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const bgRes = runCompanion(["adversarial-review", "--background"], {
    cwd: repo,
    env: { MCODE_SLEEP_MS: "3000" }
  });

  assert.equal(bgRes.status, 0);
  const match = bgRes.stdout.match(/Job (adversarial-review-[a-z0-9-]+) started in the background\./);
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

test("finished adversarial review Job is never a resume-candidate and running Job does not block delegate --resume", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const advRes = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });
  assert.equal(advRes.status, 0);

  // Finished adversarial review job must not be a resume candidate
  const candidateRes = runCompanion(["resume-candidate", "--json"], {
    cwd: repo,
    pluginDataDir: advRes.pluginDataDir
  });
  assert.equal(candidateRes.status, 0);
  const candidateData = JSON.parse(candidateRes.stdout);
  assert.equal(candidateData.hasCandidate, false);

  // Create a previous finished delegate Job that has an mcode session id
  const delegate1 = runCompanion(["delegate", "first task"], {
    cwd: repo,
    pluginDataDir: advRes.pluginDataDir
  });
  assert.equal(delegate1.status, 0);

  // Start an adversarial review Job running in the background
  const bgAdv = runCompanion(["adversarial-review", "--background"], {
    cwd: repo,
    pluginDataDir: advRes.pluginDataDir,
    env: { MCODE_SLEEP_MS: "3000" }
  });
  assert.equal(bgAdv.status, 0);

  // delegate --resume must NOT be blocked by running/queued adversarial review Job
  const resumeRes = runCompanion(["delegate", "--resume", "followup task"], {
    cwd: repo,
    pluginDataDir: advRes.pluginDataDir
  });
  assert.equal(resumeRes.status, 0);

  // Clean up running background adversarial review job
  const match = bgAdv.stdout.match(/Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  if (match) {
    runCompanion(["cancel", match[1]], { cwd: repo, pluginDataDir: advRes.pluginDataDir });
  }
});

test('adversarial-review command invocation with background flag and branch target: ["adversarial-review", "--background", "--base main focus words"]', () => {
  const repo = initTestRepo();
  execFileSync("git", ["checkout", "-b", "feature/my-branch"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "calc.js"), "export function divide(a, b) { return a / b; }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "feature commit"], { cwd: repo });

  const fixture = path.join(__dirname, "fixtures/adversarial-review-branch.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--background", "--base main focus words"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const match = res.stdout.match(/Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const jobId = match[1];

  const waitRes = runCompanion(["status", jobId, "--wait", "--timeout-ms", "5000"], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });
  assert.equal(waitRes.status, 0);
  assert.match(waitRes.stdout, /State:\s+completed/);
  assert.match(waitRes.stdout, /Kind:\s+adversarial-review/);
  assert.ok(waitRes.recordedStdin, "Background worker must pass stdin prompt to mcode");
  assert.match(waitRes.recordedStdin, /focus words/);

  const statusRes = runCompanion(["status", jobId], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });
  assert.match(statusRes.stdout, /Branch changes compared to base 'main'/);
});

test('adversarial-review command invocation with background flag and empty arguments: ["adversarial-review", "--background", ""]', () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--background", ""], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const match = res.stdout.match(/Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const jobId = match[1];

  const waitRes = runCompanion(["status", jobId, "--wait", "--timeout-ms", "5000"], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });
  assert.equal(waitRes.status, 0);
  assert.match(waitRes.stdout, /State:\s+completed/);
});

test('adversarial-review command invocation with background flag and focus: ["adversarial-review", "--background", "check this"]', () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "function add(a, b) { return a - b; }\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review", "--background", "check this"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const match = res.stdout.match(/Job (adversarial-review-[a-z0-9-]+) started in the background\./);
  const jobId = match[1];

  const waitRes = runCompanion(["status", jobId, "--wait", "--timeout-ms", "5000"], {
    cwd: repo,
    pluginDataDir: res.pluginDataDir
  });
  assert.equal(waitRes.status, 0);
  assert.match(waitRes.stdout, /State:\s+completed/);
  assert.ok(waitRes.recordedStdin, "Background worker must pass stdin prompt to mcode");
  assert.match(waitRes.recordedStdin, /check this/);
});

test("prompt filling preserves special replacement patterns verbatim", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "math.js"), "echo $$ cost $& and $'\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.ok(res.recordedStdin.includes("echo $$ cost $& and $'"), "Special replace patterns must appear verbatim in prompt");
});

test("untracked file inside a new directory is covered", () => {
  const repo = initTestRepo();
  const subDir = path.join(repo, "newdir", "sub");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "nested.js"), "export const nested = true;\n", "utf8");

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.recordedStdin, /newdir\/sub\/nested\.js/);
  assert.match(res.recordedStdin, /export const nested = true;/);
});

test("untracked binary file is listed by path", () => {
  const repo = initTestRepo();
  const binPath = path.join(repo, "binary-data.bin");
  const binBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  fs.writeFileSync(binPath, binBuffer);

  const fixture = path.join(__dirname, "fixtures/adversarial-review-working-tree.stream.jsonl");
  const res = runCompanion(["adversarial-review"], {
    cwd: repo,
    env: { MCODE_FIXTURE: fixture }
  });

  assert.equal(res.status, 0);
  assert.match(res.recordedStdin, /Untracked file \(binary\): binary-data\.bin/);
  assert.ok(!res.recordedStdin.includes("\u0000"), "Binary file bytes must not be dumped into stdin prompt");
});
