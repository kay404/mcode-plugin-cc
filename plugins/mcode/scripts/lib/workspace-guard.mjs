import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GUARD_REASONS = {
  "not-a-git-repo": "Read-only check could not run: not a git repository.",
  "git-status-failed": "Read-only check could not run: git status failed."
};

export function isGitWorkspace(workspaceRoot) {
  try {
    const stdout = execFileSync("git", ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function getGitRef(workspaceRoot, args) {
  try {
    const stdout = execFileSync("git", ["-C", workspaceRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseGitStatusZ(buffer) {
  const entries = [];
  let i = 0;
  while (i < buffer.length) {
    const nulIdx = buffer.indexOf(0, i);
    if (nulIdx === -1) break;
    const header = buffer.subarray(i, nulIdx).toString("utf8");
    const code = header.slice(0, 2);
    const p = header.slice(3);
    i = nulIdx + 1;

    if (code.includes("R") || code.includes("C")) {
      const origNulIdx = buffer.indexOf(0, i);
      const origPath = buffer.subarray(i, origNulIdx).toString("utf8");
      i = origNulIdx + 1;
      entries.push({ code, path: p, origPath });
    } else {
      entries.push({ code, path: p });
    }
  }
  return entries;
}

function fingerprintWorkspacePath(workspaceRoot, relPath) {
  const fullPath = path.resolve(workspaceRoot, relPath);
  try {
    const lstat = fs.lstatSync(fullPath);
    const mode = lstat.mode;
    if (lstat.isSymbolicLink()) {
      return {
        mode,
        hash: createHash("sha256").update(fs.readlinkSync(fullPath)).digest("hex")
      };
    }
    if (lstat.isDirectory()) {
      return { mode, hash: "directory" };
    }
    return {
      mode,
      hash: createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")
    };
  } catch {
    return { mode: null, hash: null };
  }
}

export function captureWorkspaceSnapshot(workspaceRoot) {
  if (!isGitWorkspace(workspaceRoot)) {
    return { isGit: false, reason: "not-a-git-repo", files: {} };
  }

  // debt: writes to gitignored paths such as .env or build output are not detected; scanning ignored files is unbounded.
  let statusBuffer;
  try {
    statusBuffer = execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain=v1", "-z", "-uall"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return { isGit: true, reason: "git-status-failed", files: {} };
  }

  const head = getGitRef(workspaceRoot, ["rev-parse", "HEAD"]);
  const stash = getGitRef(workspaceRoot, ["rev-parse", "--verify", "-q", "refs/stash"]);
  const entries = parseGitStatusZ(statusBuffer);
  const files = {};

  for (const entry of entries) {
    const fp = fingerprintWorkspacePath(workspaceRoot, entry.path);
    files[entry.path] = { code: entry.code, ...fp };
    if (entry.origPath) {
      const origFp = fingerprintWorkspacePath(workspaceRoot, entry.origPath);
      files[entry.origPath] = { code: entry.code, ...origFp };
    }
  }

  return { isGit: true, head, stash, files };
}

export function evaluateWorkspaceGuard(snapshotBefore, workspaceRoot) {
  if (!snapshotBefore.isGit) {
    return { checked: false, reason: snapshotBefore.reason, changedPaths: [] };
  }

  if (snapshotBefore.reason) {
    return { checked: false, reason: snapshotBefore.reason, changedPaths: [] };
  }

  const snapshotAfter = captureWorkspaceSnapshot(workspaceRoot);
  if (!snapshotAfter.isGit || snapshotAfter.reason) {
    return { checked: false, reason: snapshotAfter.reason ?? "not-a-git-repo", changedPaths: [] };
  }

  const allPaths = new Set([
    ...Object.keys(snapshotBefore.files),
    ...Object.keys(snapshotAfter.files)
  ]);

  const changed = [];
  for (const p of allPaths) {
    const b = snapshotBefore.files[p];
    const a = snapshotAfter.files[p];

    if (!b || !a || b.code !== a.code || b.hash !== a.hash || b.mode !== a.mode) {
      changed.push(p);
    }
  }

  changed.sort();

  const outcome = {
    checked: true,
    reason: null,
    changedPaths: changed
  };

  if (snapshotBefore.head && snapshotAfter.head && snapshotBefore.head !== snapshotAfter.head) {
    outcome.headMoved = { from: snapshotBefore.head, to: snapshotAfter.head };
  } else if (!snapshotBefore.head && snapshotAfter.head) {
    outcome.headMoved = { from: "none", to: snapshotAfter.head };
  }

  if (snapshotBefore.stash !== snapshotAfter.stash) {
    outcome.stashChanged = true;
  }

  return outcome;
}
