import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);

const MAX_JOBS = 50;
const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "MCODE_PLUGIN_DATA";
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

export function resolveStateDir(cwd = process.cwd(), options = {}) {
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
  const pluginDataDir = options.pluginDataDir ?? process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd = process.cwd(), options = {}) {
  return path.join(resolveStateDir(cwd, options), "jobs");
}

export function resolveJobFile(cwd, jobId, options = {}) {
  return path.join(resolveJobsDir(cwd, options), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId, options = {}) {
  return path.join(resolveJobsDir(cwd, options), `${jobId}.log`);
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

export function loadState(cwd = process.cwd(), options = {}) {
  const stateFile = path.join(resolveStateDir(cwd, options), "state.json");
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

export function saveJob(cwd, job, options = {}) {
  const jobsDir = resolveJobsDir(cwd, options);
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobFile = resolveJobFile(cwd, job.id, options);
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2), "utf8");

  const state = loadState(cwd, options);
  const existingIndex = state.jobs.findIndex((j) => j.id === job.id);
  const indexEntry = {
    id: job.id,
    kind: job.kind,
    title: job.title,
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
      const prunedFile = resolveJobFile(cwd, item.id, options);
      const prunedLog = resolveJobLogFile(cwd, item.id, options);
      if (fs.existsSync(prunedFile)) {
        fs.unlinkSync(prunedFile);
      }
      if (fs.existsSync(prunedLog)) {
        fs.unlinkSync(prunedLog);
      }
    }
  }

  const stateFile = path.join(resolveStateDir(cwd, options), "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

export function appendJobLog(cwd, jobId, line) {
  const jobsDir = resolveJobsDir(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = resolveJobLogFile(cwd, jobId);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

export function loadJob(cwd, jobId, options = {}) {
  const jobFile = resolveJobFile(cwd, jobId, options);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

export function loadJobOrThrow(cwd, jobId, options = {}) {
  const job = loadJob(cwd, jobId, options);
  if (!job) {
    throw new Error(`Job "${jobId}" record not found.`);
  }
  return job;
}

export function readJobLogs(cwd, jobId) {
  const logFile = resolveJobLogFile(cwd, jobId);
  if (!fs.existsSync(logFile)) {
    return [];
  }
  try {
    const content = fs.readFileSync(logFile, "utf8");
    return content.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

export function getJobProgressPreview(cwd, jobId) {
  const lines = readJobLogs(cwd, jobId);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    const match = raw.match(/^\[[^\]]+\]\s*(.*)$/);
    const text = match ? match[1] : raw;
    if (!text.startsWith("Completed with status")) {
      return text.length > 60 ? `${text.slice(0, 57)}...` : text;
    }
  }
  return "-";
}

export function filterJobsBySession(jobs, options = {}) {
  if (options.all || options.sessionId === undefined) {
    return jobs;
  }
  return jobs.filter((j) => j.sessionId === options.sessionId);
}

export function findLatestJob(cwd, options = {}) {
  const candidates = filterJobsBySession(loadState(cwd).jobs, options);
  if (candidates.length === 0) {
    throw new Error("No Jobs found for this session.");
  }
  return loadJobOrThrow(cwd, candidates[0].id);
}

export function findLatestActiveJob(cwd, options = {}) {
  const candidates = filterJobsBySession(loadState(cwd).jobs, options);
  const active = candidates.find((j) => !FINISHED_STATUSES.has(j.status));
  if (!active) {
    throw new Error("No running or queued Jobs found for this session.");
  }
  return loadJobOrThrow(cwd, active.id);
}

export function isProcessAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {}
  try {
    process.kill(pid, 0);
    return true;
  } catch {}
  return false;
}

export function terminateJobProcess(pid, { graceMs = 200 } = {}) {
  if (!pid || typeof pid !== "number") return;

  function sendSignal(signal) {
    let sent = false;
    try {
      process.kill(-pid, signal);
      sent = true;
    } catch {}

    try {
      process.kill(pid, signal);
      sent = true;
    } catch {}

    return sent;
  }

  if (!sendSignal("SIGTERM")) {
    return;
  }

  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!isProcessAlive(pid)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }

  if (isProcessAlive(pid)) {
    sendSignal("SIGKILL");
  }
}

export function findLatestFinishedJob(cwd, options = {}) {
  const candidates = filterJobsBySession(loadState(cwd).jobs, options);
  const finished = candidates.find((j) => FINISHED_STATUSES.has(j.status));
  if (!finished) {
    throw new Error("No finished Jobs found for this session.");
  }
  return loadJobOrThrow(cwd, finished.id);
}

export function findResumeCandidate(cwd, options = {}) {
  const candidates = filterJobsBySession(loadState(cwd).jobs, options);
  const match = candidates.find(
    (j) => j.kind === "delegate" && FINISHED_STATUSES.has(j.status) && Boolean(j.mcodeSessionId)
  );
  if (!match) {
    return null;
  }
  return loadJobOrThrow(cwd, match.id);
}

export function findActiveDelegation(cwd, options = {}) {
  const candidates = filterJobsBySession(loadState(cwd).jobs, options);
  const match = candidates.find(
    (j) => j.kind === "delegate" && (j.status === "running" || j.status === "queued")
  );
  if (!match) {
    return null;
  }
  return loadJobOrThrow(cwd, match.id);
}

export function findJob(cwd, selector, options = {}) {
  const candidates = filterJobsBySession(loadState(cwd).jobs, options);
  const exactMatch = candidates.find((j) => j.id === selector);
  if (exactMatch) {
    return loadJobOrThrow(cwd, exactMatch.id);
  }

  const prefixMatches = candidates.filter((j) => j.id.startsWith(selector));
  if (prefixMatches.length === 0) {
    throw new Error(`No Job found matching "${selector}".`);
  }

  if (prefixMatches.length > 1) {
    const candidateList = prefixMatches.map((j) => `  ${j.id}`).join("\n");
    throw new Error(`Ambiguous Job ID prefix "${selector}". Matching Jobs:\n${candidateList}`);
  }

  return loadJobOrThrow(cwd, prefixMatches[0].id);
}

export function listJobs(cwd, options = {}) {
  const jobs = filterJobsBySession(loadState(cwd).jobs, options);
  return jobs.map((j) => ({
    ...j,
    progressPreview: getJobProgressPreview(cwd, j.id)
  }));
}
