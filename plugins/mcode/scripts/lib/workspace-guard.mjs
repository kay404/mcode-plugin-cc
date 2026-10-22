import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
      if (origNulIdx !== -1) {
        const origPath = buffer.subarray(i, origNulIdx).toString("utf8");
        i = origNulIdx + 1;
        entries.push({ code, path: p, origPath });
      } else {
        entries.push({ code, path: p });
      }
    } else {
      entries.push({ code, path: p });
    }
  }
  return entries;
}

function hashWorkspacePath(workspaceRoot, relPath) {
  const fullPath = path.resolve(workspaceRoot, relPath);
  try {
    const lstat = fs.lstatSync(fullPath);
    if (lstat.isSymbolicLink()) {
      return createHash("sha256").update(fs.readlinkSync(fullPath)).digest("hex");
    }
    if (lstat.isDirectory()) {
      return "directory";
    }
    return createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
  } catch {
    return null;
  }
}

export function captureWorkspaceSnapshot(workspaceRoot) {
  if (!isGitWorkspace(workspaceRoot)) {
    return { isGit: false, files: {} };
  }

  let statusBuffer;
  try {
    statusBuffer = execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain=v1", "-z", "-uall"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return { isGit: false, files: {} };
  }

  const entries = parseGitStatusZ(statusBuffer);
  const files = {};

  for (const entry of entries) {
    files[entry.path] = {
      code: entry.code,
      hash: hashWorkspacePath(workspaceRoot, entry.path)
    };
    if (entry.origPath) {
      files[entry.origPath] = {
        code: entry.code,
        hash: hashWorkspacePath(workspaceRoot, entry.origPath)
      };
    }
  }

  return { isGit: true, files };
}

export function evaluateWorkspaceGuard(snapshotBefore, workspaceRoot) {
  if (!snapshotBefore || !snapshotBefore.isGit || !isGitWorkspace(workspaceRoot)) {
    return {
      checked: false,
      reason: "not-a-git-repo",
      message: "Read-only check could not run: not a git repository.",
      violation: false,
      changedPaths: []
    };
  }

  const snapshotAfter = captureWorkspaceSnapshot(workspaceRoot);
  if (!snapshotAfter.isGit) {
    return {
      checked: false,
      reason: "not-a-git-repo",
      message: "Read-only check could not run: not a git repository.",
      violation: false,
      changedPaths: []
    };
  }

  const allPaths = new Set([
    ...Object.keys(snapshotBefore.files),
    ...Object.keys(snapshotAfter.files)
  ]);

  const changed = [];
  for (const p of allPaths) {
    const b = snapshotBefore.files[p];
    const a = snapshotAfter.files[p];

    if (!b || !a) {
      changed.push(p);
    } else if (b.code !== a.code || b.hash !== a.hash) {
      changed.push(p);
    }
  }

  changed.sort();

  return {
    checked: true,
    reason: null,
    violation: changed.length > 0,
    changedPaths: changed
  };
}
