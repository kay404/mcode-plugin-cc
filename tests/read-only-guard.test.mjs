import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");
const FAKE_MCODE = path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs");
const FIXTURES_DIR = path.join(ROOT_DIR, "tests/fixtures");

function initTestRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-guard-test-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "tracked.txt"), "initial tracked content\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

function runCompanionInRepo(repoDir, args, options = {}) {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-data-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-bin-"));

  const symlinkPath = path.join(binDir, "mcode");
  try {
    fs.symlinkSync(FAKE_MCODE, symlinkPath);
  } catch {
    fs.copyFileSync(FAKE_MCODE, symlinkPath);
    fs.chmodSync(symlinkPath, 0o755);
  }

  const combinedEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    CLAUDE_SESSION_ID: "test-guard-session-001",
    MCODE_FIXTURE: path.join(FIXTURES_DIR, "success.stream.jsonl"),
    ...(options.env ?? {})
  };

  const result = spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: repoDir,
    env: combinedEnv,
    encoding: "utf8"
  });

  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  return { status, stdout, stderr, pluginDataDir };
}

test("read-only delegation detects modified file, renders violation first, and does not revert changes", () => {
  const repo = initTestRepo();
  const res = runCompanionInRepo(repo, ["delegate", "--read-only", "inspect code"], {
    env: {
      MCODE_MODIFY_FILE: "tracked.txt:unexpected modification\n"
    }
  });

  assert.equal(res.status, 0);
  assert.ok(
    res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"),
    `Expected violation header first, got:\n${res.stdout}`
  );
  assert.ok(res.stdout.includes("tracked.txt"));
  const violationIdx = res.stdout.indexOf("Read-only violation:");
  const outputIdx = res.stdout.indexOf("OK");
  assert.ok(violationIdx >= 0 && outputIdx > violationIdx, "Violation must appear before mcode output");

  // Verify file was NOT reverted
  const content = fs.readFileSync(path.join(repo, "tracked.txt"), "utf8");
  assert.equal(content, "unexpected modification\n");
});

test("read-only delegation detects newly created file and renders violation first", () => {
  const repo = initTestRepo();
  const res = runCompanionInRepo(repo, ["delegate", "--read-only", "inspect code"], {
    env: {
      MCODE_CREATE_FILE: "created.txt:new file content\n"
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"));
  assert.ok(res.stdout.includes("created.txt"));

  // Verify created file was NOT deleted / reverted
  assert.ok(fs.existsSync(path.join(repo, "created.txt")));
});

test("read-only delegation detects deleted file and renders violation first", () => {
  const repo = initTestRepo();
  const res = runCompanionInRepo(repo, ["delegate", "--read-only", "inspect code"], {
    env: {
      MCODE_DELETE_FILE: "tracked.txt"
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"));
  assert.ok(res.stdout.includes("tracked.txt"));
  assert.ok(!fs.existsSync(path.join(repo, "tracked.txt")));
});

test("pre-existing uncommitted changes that mcode did not touch are not reported", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "dirty-preexisting.txt"), "pre-existing dirty content\n", "utf8");

  const res = runCompanionInRepo(repo, ["delegate", "--read-only", "clean inspection"]);

  assert.equal(res.status, 0);
  assert.ok(!res.stdout.includes("Read-only violation"));
  assert.ok(!res.stdout.includes("dirty-preexisting.txt"));
  assert.ok(res.stdout.includes("OK"));
});

test("further edits to an already-dirty file are reported as violations", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "dirty-file.txt"), "pre-existing content\n", "utf8");

  const res = runCompanionInRepo(repo, ["delegate", "--read-only", "modify dirty file"], {
    env: {
      MCODE_MODIFY_FILE: "dirty-file.txt:further edits by mcode\n"
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"));
  assert.ok(res.stdout.includes("dirty-file.txt"));
});

test("read-only delegation outside a git repo completes and reports check could not run", () => {
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-guard-nongit-"));
  const res = runCompanionInRepo(nonGitDir, ["delegate", "--read-only", "inspect non-git dir"]);

  assert.equal(res.status, 0);
  assert.ok(
    res.stdout.startsWith("Read-only check could not run: not a git repository."),
    `Expected notice first, got:\n${res.stdout}`
  );
  assert.ok(res.stdout.includes("OK"));
});

test("read-only delegation outputs structured readOnlyViolation in --json mode", () => {
  const repo = initTestRepo();
  const res = runCompanionInRepo(repo, ["delegate", "--read-only", "--json", "inspect code with json"], {
    env: {
      MCODE_CREATE_FILE: "json-created.txt:content\n"
    }
  });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "completed");
  assert.ok(parsed.readOnlyViolation);
  assert.ok(Array.isArray(parsed.readOnlyViolation.changedPaths));
  assert.ok(parsed.readOnlyViolation.changedPaths.includes("json-created.txt"));
});

test("non-read-only delegation does not trigger read-only violation even if files are modified", () => {
  const repo = initTestRepo();
  const res = runCompanionInRepo(repo, ["delegate", "write delegation allowed to change files"], {
    env: {
      MCODE_CREATE_FILE: "allowed.txt:allowed content\n"
    }
  });

  assert.equal(res.status, 0);
  assert.ok(!res.stdout.includes("Read-only violation"));
  assert.ok(fs.existsSync(path.join(repo, "allowed.txt")));
});
