import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir, runCompanion } from "./helpers/run-companion.mjs";

function initTestRepo() {
  const dir = makeTempDir("mcode-guard-test-");
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "tracked.txt"), "initial tracked content\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

test("read-only delegation detects modified file, renders violation first, and does not revert changes", () => {
  const repo = initTestRepo();
  const res = runCompanion(["delegate", "--read-only", "inspect code"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "modify", path: "tracked.txt", content: "unexpected modification\n" }
      ])
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
  const res = runCompanion(["delegate", "--read-only", "inspect code"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "create", path: "created.txt", content: "new file content\n" }
      ])
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
  const res = runCompanion(["delegate", "--read-only", "inspect code"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "delete", path: "tracked.txt" }
      ])
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

  const res = runCompanion(["delegate", "--read-only", "clean inspection"], { cwd: repo });

  assert.equal(res.status, 0);
  assert.ok(!res.stdout.includes("Read-only violation"));
  assert.ok(!res.stdout.includes("dirty-preexisting.txt"));
  assert.ok(res.stdout.includes("OK"));
});

test("further edits to an already-dirty file are reported as violations", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, "dirty-file.txt"), "pre-existing content\n", "utf8");

  const res = runCompanion(["delegate", "--read-only", "modify dirty file"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "modify", path: "dirty-file.txt", content: "further edits by mcode\n" }
      ])
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"));
  assert.ok(res.stdout.includes("dirty-file.txt"));
});

test("read-only delegation detects commit moving HEAD", () => {
  const repo = initTestRepo();
  const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const res = runCompanion(["delegate", "--read-only", "commit in read only"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "git", args: ["commit", "--allow-empty", "-m", "commit by mcode"] }
      ])
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"));
  assert.ok(res.stdout.includes(`HEAD moved: ${initialHead} →`));
});

test("read-only delegation detects git stash change", () => {
  const repo = initTestRepo();

  const res = runCompanion(["delegate", "--read-only", "stash in read only"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "modify", path: "tracked.txt", content: "modified before stash\n" },
        { action: "git", args: ["stash"] }
      ])
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"));
  assert.ok(res.stdout.includes("stash changed"));
});

test("read-only delegation detects file mode change on already-dirty file", () => {
  const repo = initTestRepo();
  const scriptPath = path.join(repo, "script.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

  const res = runCompanion(["delegate", "--read-only", "chmod script"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "chmod", path: "script.sh", mode: 0o755 }
      ])
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith("Read-only violation: files were modified during a read-only delegation:"));
  assert.ok(res.stdout.includes("script.sh"));
});

test("read-only delegation reports git status failed when git status fails inside a git repo", () => {
  const repo = initTestRepo();
  fs.writeFileSync(path.join(repo, ".git/index"), "CORRUPT_INDEX");

  const res = runCompanion(["delegate", "--read-only", "broken status test"], { cwd: repo });

  assert.equal(res.status, 0);
  assert.ok(
    res.stdout.startsWith("Read-only check could not run: git status failed."),
    `Expected git status failed notice, got:\n${res.stdout}`
  );
  assert.ok(!res.stdout.includes("not a git repository"));
});

test("read-only delegation outside a git repo completes and reports check could not run", () => {
  const nonGitDir = makeTempDir("mcode-guard-nongit-");
  const res = runCompanion(["delegate", "--read-only", "inspect non-git dir"], { cwd: nonGitDir });

  assert.equal(res.status, 0);
  assert.ok(
    res.stdout.startsWith("Read-only check could not run: not a git repository."),
    `Expected notice first, got:\n${res.stdout}`
  );
  assert.ok(res.stdout.includes("OK"));
});

test("read-only delegation outputs structured readOnlyGuard in --json mode", () => {
  const repo = initTestRepo();
  const res = runCompanion(["delegate", "--read-only", "--json", "inspect code with json"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "create", path: "json-created.txt", content: "content\n" }
      ])
    }
  });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "completed");
  assert.ok(parsed.readOnlyGuard);
  assert.equal(parsed.readOnlyGuard.checked, true);
  assert.ok(Array.isArray(parsed.readOnlyGuard.changedPaths));
  assert.ok(parsed.readOnlyGuard.changedPaths.includes("json-created.txt"));
  assert.equal(parsed.readOnlyViolation, undefined);
});

test("non-read-only delegation does not trigger read-only violation even if files are modified", () => {
  const repo = initTestRepo();
  const res = runCompanion(["delegate", "write delegation allowed to change files"], {
    cwd: repo,
    env: {
      MCODE_MUTATIONS: JSON.stringify([
        { action: "create", path: "allowed.txt", content: "allowed content\n" }
      ])
    }
  });

  assert.equal(res.status, 0);
  assert.ok(!res.stdout.includes("Read-only violation"));
  assert.ok(fs.existsSync(path.join(repo, "allowed.txt")));
});
