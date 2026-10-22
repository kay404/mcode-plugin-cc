import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MAX_JOBS = 50;
const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "mcode-companion");

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

export function resolveStateDir(cwd = process.cwd()) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalRoot = workspaceRoot;
  try {
    canonicalRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    // Keep fallback to workspaceRoot
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd = process.cwd()) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    jobs: []
  };
}

export function generateJobId(kind) {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${kind}-${timestamp}-${randomSuffix}`;
}

export function loadState(cwd = process.cwd()) {
  const stateFile = path.join(resolveStateDir(cwd), "state.json");
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      version: parsed.version ?? STATE_VERSION,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function saveJob(cwd, job) {
  const jobsDir = resolveJobsDir(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobFile = resolveJobFile(cwd, job.id);
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2), "utf8");

  const state = loadState(cwd);
  const existingIndex = state.jobs.findIndex((j) => j.id === job.id);
  const indexEntry = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    reason: job.reason ?? null,
    sessionId: job.sessionId ?? null,
    mcodeSessionId: job.mcodeSessionId ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };

  if (existingIndex >= 0) {
    state.jobs[existingIndex] = indexEntry;
  } else {
    state.jobs.unshift(indexEntry);
  }

  state.jobs.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

  if (state.jobs.length > MAX_JOBS) {
    const pruned = state.jobs.slice(MAX_JOBS);
    state.jobs = state.jobs.slice(0, MAX_JOBS);
    for (const item of pruned) {
      const prunedFile = resolveJobFile(cwd, item.id);
      const prunedLog = resolveJobLogFile(cwd, item.id);
      if (fs.existsSync(prunedFile)) {
        fs.unlinkSync(prunedFile);
      }
      if (fs.existsSync(prunedLog)) {
        fs.unlinkSync(prunedLog);
      }
    }
  }

  const stateFile = path.join(resolveStateDir(cwd), "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

export function appendJobLog(cwd, jobId, line) {
  const jobsDir = resolveJobsDir(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = resolveJobLogFile(cwd, jobId);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}
