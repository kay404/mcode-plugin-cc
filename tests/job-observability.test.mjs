import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir, runCompanion } from "./helpers/run-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const REPORTED_MODEL = "custom_provider:magpie/minimax-code~MiniMax-M3.1-Flash";

function initTestRepo() {
  const dir = makeTempDir("mcode-observability-test-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "tracked.txt"), "initial\n", "utf8");
  fs.writeFileSync(path.join(dir, "already-untracked.txt"), "user file\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function latestJob(pluginDataDir) {
  const res = runCompanion(["status", "--json"], { pluginDataDir });
  assert.equal(res.status, 0, res.stderr);
  const id = JSON.parse(res.stdout)[0].id;
  return JSON.parse(runCompanion(["status", id, "--json"], { pluginDataDir }).stdout);
}

test("result, status and JSON report the model mcode actually ran, with effort and permission", () => {
  const pluginDataDir = makeTempDir("mcode-test-observability-");
  const res = runCompanion(["delegate", "task"], { pluginDataDir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`mcode run: model ${REPORTED_MODEL}, effort mcode default, permission smart\\n$`));

  const job = latestJob(pluginDataDir);
  assert.equal(job.mcodeModel, REPORTED_MODEL);
  assert.equal(job.permission, "smart");

  const detail = runCompanion(["status", job.id], { pluginDataDir });
  assert.match(detail.stdout, new RegExp(`Run settings:   model ${REPORTED_MODEL}, effort mcode default, permission smart`));
});

test("background launch prints the requested run settings under the Job line", () => {
  const pluginDataDir = makeTempDir("mcode-test-observability-");
  const res = runCompanion(["delegate", "--background", "--read-only", "--effort", "high", "task"], { pluginDataDir });
  assert.equal(res.status, 0, res.stderr);
  const [first, second] = res.stdout.split("\n");
  assert.match(first, /^Job delegate-\S+ started in the background\.$/);
  assert.equal(second, "Run settings: model mcode default, effort high, permission smart, read-only");
  runCompanion(["status", "--wait", "--timeout-ms", "10000"], { pluginDataDir });
});

test("tool calls blocked by smart permission are listed in the result and status", () => {
  const pluginDataDir = makeTempDir("mcode-test-observability-");
  const res = runCompanion(["delegate", "write outside"], {
    pluginDataDir,
    env: { MCODE_FIXTURE: path.join(FIXTURES_DIR, "permission-denied-handled.stream.jsonl") }
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /smart permission blocked these tool calls[^\n]*--full allows them\):\n  - bash: printf 'test' > \/tmp\/mcode-outside-test\.txt\n  - write: \/tmp\/mcode-outside-test\.txt\n/);

  const job = latestJob(pluginDataDir);
  assert.deepEqual(job.blockedToolCalls, [
    "bash: printf 'test' > /tmp/mcode-outside-test.txt",
    "write: /tmp/mcode-outside-test.txt"
  ]);
  const detail = runCompanion(["status", job.id], { pluginDataDir });
  assert.match(detail.stdout, /Blocked by smart permission:\n  - bash: printf/);
});

test("status shows only the first line of a long multi-line prompt as the title", () => {
  const pluginDataDir = makeTempDir("mcode-test-observability-");
  const prompt = "Implement the FCR gateway\nScope: gateway only\nState: should not look like a field";
  assert.equal(runCompanion(["delegate", prompt], { pluginDataDir }).status, 0);

  const job = latestJob(pluginDataDir);
  const detail = runCompanion(["status", job.id], { pluginDataDir }).stdout;
  assert.match(detail, /^Title:          Implement the FCR gateway$/m);
  assert.doesNotMatch(detail, /^Scope:/m);
  assert.equal(detail.match(/^State:/gm).length, 1);
  assert.equal(job.prompt, prompt);
});

test("status --wait exits 124 when it times out, so callers need not match the message", () => {
  const pluginDataDir = makeTempDir("mcode-test-observability-");
  const launch = runCompanion(["delegate", "--background", "--json", "slow task"], {
    pluginDataDir,
    env: { MCODE_SLEEP_MS: "5000" }
  });
  const { id } = JSON.parse(launch.stdout);
  try {
    const waited = runCompanion(["status", id, "--wait", "--timeout-ms", "300"], { pluginDataDir });
    assert.equal(waited.status, 124);
    assert.match(waited.stderr, /Timed out waiting for Job/);

    const missing = runCompanion(["status", "no-such-job", "--wait", "--timeout-ms", "300"], { pluginDataDir });
    assert.equal(missing.status, 1);
  } finally {
    runCompanion(["cancel", id], { pluginDataDir });
  }
});

test("a write-mode delegation lists the untracked files it left behind, not ones that were already there", () => {
  const repo = initTestRepo();
  const res = runCompanion(["delegate", "generate config"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "create", path: "configs/config.yaml", content: "db: local\n" },
        { action: "modify", path: "tracked.txt", content: "changed\n" }
      ])
    }
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /New untracked files left in the working tree:\n  - configs\/config\.yaml\n/);
  assert.doesNotMatch(res.stdout, /already-untracked\.txt|tracked\.txt\n/);
});

test("a read-only delegation does not report new untracked files separately", () => {
  const repo = initTestRepo();
  const res = runCompanion(["delegate", "--read-only", "inspect"], { cwd: repo });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /New untracked files/);
});
