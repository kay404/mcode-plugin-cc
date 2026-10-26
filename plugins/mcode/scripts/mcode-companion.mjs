#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  splitSubcommandArgs,
  assertWaitBackgroundExclusive,
  DELEGATE_OPTION_CONFIG,
  DELEGATE_WORKER_OPTION_CONFIG,
  SETUP_OPTION_CONFIG,
  RESUME_CANDIDATE_OPTION_CONFIG,
  STATUS_OPTION_CONFIG,
  RESULT_OPTION_CONFIG,
  CANCEL_OPTION_CONFIG,
  REVIEW_OPTION_CONFIG,
  ADVERSARIAL_REVIEW_OPTION_CONFIG
} from "./lib/args.mjs";
import {
  generateJobId,
  saveJob,
  loadJob,
  loadJobOrThrow,
  readJobLogs,
  listJobs,
  findJob,
  findLatestJob,
  findLatestActiveJob,
  findLatestFinishedJob,
  findResumeCandidate,
  findActiveDelegation,
  terminateJobProcess,
  isProcessAlive,
  loadState,
  appendJobLog,
  resolveWorkspaceRoot,
  FINISHED_STATUSES
} from "./lib/job-store.mjs";
import { runMcode, wrapReadOnlyPrompt } from "./lib/mcode-runner.mjs";
import {
  renderDelegationResult,
  renderStatusTable,
  renderJobDetail,
  buildJobJsonPayload,
  describeRunSettings,
  formatAge,
  shortTitle
} from "./lib/render.mjs";
import { runSetupChecks, renderSetupResult } from "./lib/setup.mjs";
import { captureWorkspaceSnapshot, evaluateWorkspaceGuard, isGitWorkspace, listUntrackedPaths } from "./lib/workspace-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_ID_ENV = "MCODE_CLAUDE_SESSION_ID";

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/mcode-companion.mjs delegate [--read-only] [--full] [--resume] [--fresh] [--model <model>] [--effort <effort>] [--json] <task>",
    "  node scripts/mcode-companion.mjs resume-candidate [--json]",
    "  node scripts/mcode-companion.mjs review [--wait] [--background] [--json]",
    "  node scripts/mcode-companion.mjs adversarial-review [--base <ref> | --plan <path>] [--wait | --background] [--json] [focus text…]",
    "  node scripts/mcode-companion.mjs setup [--json]",
    "  node scripts/mcode-companion.mjs status [job-id] [--all] [--json]",
    "  node scripts/mcode-companion.mjs result [job-id] [--all] [--json]",
    "  node scripts/mcode-companion.mjs cancel [job-id] [--json]"
  ].join("\n"));
}

function assertGitWorkspace(cwd) {
  if (!isGitWorkspace(cwd)) {
    console.error("Error: Not a git repository.");
    process.exit(1);
  }
}

function checkNoUncommittedChanges(workspaceRoot, isJson) {
  const statusOutput = execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (!statusOutput.trim()) {
    if (isJson) {
      console.log(JSON.stringify({
        hasChanges: false,
        message: "No uncommitted changes to review."
      }, null, 2));
    } else {
      console.log("No uncommitted changes to review.");
    }
    return true;
  }
  return false;
}

async function runJobForeground(job, workspaceRoot, isJson) {
  const outcome = await executeJob(job, workspaceRoot, (line) => {
    appendJobLog(workspaceRoot, job.id, line);
    if (!isJson) {
      process.stderr.write(`[mcode] ${line}\n`);
    }
  });

  if (isJson) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write(job.renderedOutput);
  }

  if (job.status !== "completed") {
    process.exit(outcome.exitCode && outcome.exitCode !== 0 ? outcome.exitCode : 1);
  }
}

function buildJobRecord({
  id,
  kind,
  title,
  prompt = null,
  command = null,
  cwd,
  workspace,
  sessionId = null,
  isBackground = false,
  readOnly = false,
  permission = "smart",
  model = null,
  effort = null,
  mcodeSessionId = null,
  outputSchema = null
}) {
  const now = new Date().toISOString();
  return {
    id,
    kind,
    title,
    prompt,
    command,
    cwd,
    workspace,
    sessionId,
    processId: isBackground ? null : process.pid,
    readOnly,
    permission,
    model,
    effort,
    mcodeSessionId,
    outputSchema,
    status: isBackground ? "queued" : "running",
    reason: null,
    output: null,
    renderedOutput: null,
    error: null,
    usage: null,
    readOnlyGuard: null,
    createdAt: now,
    updatedAt: now
  };
}

function launchBackgroundWorker(job, workspaceRoot, logMessage, isJson) {
  appendJobLog(workspaceRoot, job.id, logMessage);

  const companionScript = path.resolve(process.argv[1]);
  const worker = spawn(process.execPath, [
    companionScript,
    "delegate-worker",
    "--job-id",
    job.id
  ], {
    cwd: job.cwd || job.workspace,
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  worker.unref();

  if (isJson) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write([
      `Job ${job.id} started in the background.`,
      `Run settings: ${describeRunSettings(job)}`,
      "",
      `To check progress:  /mcode:status ${job.id}`,
      `To read results:    /mcode:result ${job.id}`,
      `To cancel:          /mcode:cancel ${job.id}`,
      ""
    ].join("\n"));
  }
}

function markJobCancelled(job, workspaceRoot, logMessage) {
  job.status = "cancelled";
  job.reason = null;
  job.renderedOutput = renderDelegationResult(job);
  appendJobLog(workspaceRoot, job.id, logMessage);
  saveJob(workspaceRoot, job);
}

const QUEUED_GRACE_MS = 60_000;
// Same code as timeout(1), so callers can tell "still running" from a real error.
const WAIT_TIMEOUT_EXIT_CODE = 124;

// A SIGKILLed or crashed companion cannot record its own outcome; finish such Jobs when they are next read.
// A queued Job has no process yet, so it counts as lost once its worker has had ample time to claim it.
// debt: a reused PID makes a dead Job look alive until that process exits; record the process start time to tell them apart.
function reconcileLostJob(workspaceRoot, job) {
  const lost = job.status === "running"
    ? Boolean(job.processId) && !isProcessAlive(job.processId)
    : job.status === "queued" && Date.now() - Date.parse(job.createdAt) > QUEUED_GRACE_MS;
  if (!lost) return job;
  job.status = "failed";
  job.reason = "process-lost";
  job.error = null;
  job.renderedOutput = renderDelegationResult(job);
  appendJobLog(workspaceRoot, job.id, job.processId
    ? `Process ${job.processId} exited without recording a result.`
    : "Worker never started.");
  saveJob(workspaceRoot, job);
  return job;
}

function reconcileLostJobs(workspaceRoot) {
  for (const item of loadState(workspaceRoot).jobs) {
    if (FINISHED_STATUSES.has(item.status)) continue;
    const job = loadJob(workspaceRoot, item.id);
    if (!job) continue;
    // A concurrent save can drop a finished Job's last index update; the Job file is authoritative.
    if (FINISHED_STATUSES.has(job.status)) saveJob(workspaceRoot, job);
    else reconcileLostJob(workspaceRoot, job);
  }
}

async function executeJob(job, workspaceRoot, onProgress = () => {}) {
  const readOnly = job.readOnly;
  const snapshotBefore = readOnly ? captureWorkspaceSnapshot(workspaceRoot) : null;
  const untrackedBefore = readOnly ? null : listUntrackedPaths(workspaceRoot);
  const mcodePrompt = job.prompt && readOnly ? wrapReadOnlyPrompt(job.prompt) : job.prompt;
  const execCwd = job.cwd || workspaceRoot;

  function saveRunningJob() {
    if (loadJob(workspaceRoot, job.id)?.status === "cancelled") return;
    saveJob(workspaceRoot, job);
  }

  let outcome;
  try {
    outcome = await runMcode({
      command: job.command,
      cwd: execCwd,
      permission: job.permission,
      model: job.model,
      effort: job.effort,
      session: job.mcodeSessionId || undefined,
      prompt: mcodePrompt,
      outputSchema: job.outputSchema,
      onProgress,
      onSessionId: (sessionId) => {
        job.mcodeSessionId = sessionId;
        saveRunningJob();
      },
      onBlockedToolCalls: (blockedToolCalls) => {
        job.blockedToolCalls = blockedToolCalls;
        saveRunningJob();
      },
      onSignal: (signal) => markJobCancelled(job, workspaceRoot, `Job was cancelled (${signal}).`)
    });
  } catch (err) {
    outcome = {
      status: "failed",
      reason: err.reason || "error",
      output: null,
      error: { message: err.message },
      mcodeSessionId: err.sessionId || null,
      exitCode: 1,
      stderr: err.message
    };
  }

  const latestJob = loadJob(workspaceRoot, job.id) || job;
  if (latestJob.status === "cancelled") {
    return outcome;
  }

  if (readOnly) {
    job.readOnlyGuard = evaluateWorkspaceGuard(snapshotBefore, workspaceRoot);
    if (job.readOnlyGuard.changedPaths.length > 0 || job.readOnlyGuard.headMoved || job.readOnlyGuard.stashChanged) {
      appendJobLog(
        workspaceRoot,
        job.id,
        `Read-only violation detected: ${job.readOnlyGuard.changedPaths.join(", ")}`
      );
    }
  }

  if (untrackedBefore) {
    const before = new Set(untrackedBefore);
    job.newUntrackedPaths = (listUntrackedPaths(workspaceRoot) ?? []).filter((p) => !before.has(p)).sort();
  }

  job.status = outcome.status;
  job.reason = outcome.reason;
  job.output = outcome.output;
  job.error = outcome.error;
  job.usage = outcome.usage || null;
  if (outcome.mcodeSessionId) {
    job.mcodeSessionId = outcome.mcodeSessionId;
  }
  if (outcome.model) {
    job.mcodeModel = outcome.model;
  }
  if (outcome.blockedToolCalls?.length) {
    job.blockedToolCalls = outcome.blockedToolCalls;
  }
  job.stderr = outcome.stderr;
  job.renderedOutput = renderDelegationResult(job);

  // Log before saving: once a finished status is visible, the Job's files must not change again.
  appendJobLog(workspaceRoot, job.id, `Completed with status ${job.status}${job.reason ? ` (${job.reason})` : ""}`);
  saveJob(workspaceRoot, job);

  return outcome;
}

async function handleDelegate(rawTokens) {
  let parsed;
  try {
    parsed = parseArgs(rawTokens, DELEGATE_OPTION_CONFIG);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const { options, positionals } = parsed;

  if (options.resume && options.fresh) {
    console.error("Error: Cannot combine --resume and --fresh (they are mutually exclusive).");
    process.exit(1);
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.error("Error: Task prompt is required for delegation.");
    process.exit(1);
  }

  const permission = options.full ? "full" : "smart";
  const readOnly = Boolean(options["read-only"]);

  const invocationCwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(invocationCwd);
  const currentSessionId = process.env[SESSION_ID_ENV] || null;

  let targetMcodeSessionId = null;
  if (options.resume) {
    const activeDelegation = findActiveDelegation(workspaceRoot, { sessionId: currentSessionId });
    if (activeDelegation) {
      console.error(`Error: Cannot resume while a delegation in this Claude session is ${activeDelegation.status} (Job ${activeDelegation.id}).`);
      process.exit(1);
    }

    const candidate = findResumeCandidate(workspaceRoot, { sessionId: currentSessionId });
    if (!candidate) {
      console.error("Error: No resumable mcode session found for this Claude session.");
      process.exit(1);
    }

    targetMcodeSessionId = candidate.mcodeSessionId;
  }

  const jobId = generateJobId("delegate");
  const isBackground = Boolean(options.background);

  const job = buildJobRecord({
    id: jobId,
    kind: "delegate",
    title: prompt,
    prompt,
    cwd: invocationCwd,
    workspace: workspaceRoot,
    sessionId: currentSessionId,
    isBackground,
    readOnly,
    permission,
    model: options.model || null,
    effort: options.effort || null,
    mcodeSessionId: targetMcodeSessionId || null
  });

  saveJob(workspaceRoot, job);

  if (isBackground) {
    launchBackgroundWorker(job, workspaceRoot, `Queued delegation: "${prompt.slice(0, 80)}"`, options.json);
    return;
  }

  appendJobLog(workspaceRoot, jobId, `Starting delegation: "${prompt.slice(0, 80)}"`);

  const outcome = await executeJob(job, workspaceRoot, (line) => {
    appendJobLog(workspaceRoot, jobId, line);
    if (!options.json) {
      process.stderr.write(`[mcode] ${line}\n`);
    }
  });

  if (options.json) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write(renderDelegationResult(job));
  }

  if (job.status !== "completed") {
    process.exit(outcome.exitCode && outcome.exitCode !== 0 ? outcome.exitCode : 1);
  }
}

async function handleDelegateWorker(rawTokens) {
  let parsed;
  try {
    parsed = parseArgs(rawTokens, DELEGATE_WORKER_OPTION_CONFIG);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const jobId = parsed.options["job-id"];
  if (!jobId) {
    console.error("Error: --job-id is required for delegate-worker.");
    process.exit(1);
  }

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const job = loadJobOrThrow(workspaceRoot, jobId);

  if (job.status !== "queued") {
    return;
  }

  job.status = "running";
  job.processId = process.pid;
  saveJob(workspaceRoot, job);
  appendJobLog(workspaceRoot, jobId, `Worker started with PID ${process.pid}`);

  await executeJob(job, workspaceRoot, (line) => {
    appendJobLog(workspaceRoot, jobId, line);
  });
}

async function handleResumeCandidate(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, RESUME_CANDIDATE_OPTION_CONFIG);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const nonWhitespacePositionals = parsed.positionals.filter((p) => p.trim());
  if (nonWhitespacePositionals.length > 0) {
    console.error(`Unexpected argument: "${nonWhitespacePositionals[0]}". resume-candidate takes no positional arguments.`);
    process.exit(1);
  }

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const currentSessionId = process.env[SESSION_ID_ENV] || null;
  const candidate = findResumeCandidate(workspaceRoot, { sessionId: currentSessionId });

  if (parsed.options.json) {
    if (!candidate) {
      console.log(JSON.stringify({
        hasCandidate: false,
        jobId: null,
        mcodeSessionId: null,
        title: null,
        age: null
      }, null, 2));
    } else {
      const age = formatAge(candidate.createdAt);
      console.log(JSON.stringify({
        hasCandidate: true,
        jobId: candidate.id,
        mcodeSessionId: candidate.mcodeSessionId,
        title: candidate.title,
        age
      }, null, 2));
    }
  } else {
    if (!candidate) {
      console.log("No resume candidate found.");
    } else {
      console.log(`Resume candidate: ${candidate.id} (${candidate.mcodeSessionId})\n  Title: ${shortTitle(candidate.title)}\n  Age: ${formatAge(candidate.createdAt)}`);
    }
  }
}

async function handleSetup(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, SETUP_OPTION_CONFIG);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const nonWhitespacePositionals = parsed.positionals.filter((p) => p.trim());
  if (nonWhitespacePositionals.length > 0) {
    console.error(`Unexpected argument: "${nonWhitespacePositionals[0]}". setup takes no positional arguments.`);
    process.exit(1);
  }

  const result = runSetupChecks();

  if (parsed.options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(renderSetupResult(result));
  }

  const isReady = result.verdict === "ready" || result.verdict === "ready (login unverified)";
  if (!isReady) {
    process.exit(1);
  }
}

async function handleStatus(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, STATUS_OPTION_CONFIG);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const { options, positionals } = parsed;
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const currentSessionId = process.env[SESSION_ID_ENV] || null;
  const targetJobId = positionals[0] || null;

  const shouldWait = Boolean(options.wait || options["timeout-ms"] !== undefined);
  if (shouldWait) {
    const timeoutMs = options["timeout-ms"] !== undefined ? parseInt(options["timeout-ms"], 10) : 240000;
    if (options["timeout-ms"] !== undefined && (Number.isNaN(timeoutMs) || timeoutMs < 0)) {
      console.error("Error: --timeout-ms must be a non-negative number.");
      process.exit(1);
    }

    let job;
    try {
      if (targetJobId) {
        job = findJob(workspaceRoot, targetJobId, {
          all: Boolean(options.all),
          sessionId: currentSessionId
        });
      } else {
        job = findLatestJob(workspaceRoot, {
          all: Boolean(options.all),
          sessionId: currentSessionId
        });
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }

    const start = Date.now();
    let currentJob = job;
    while (!FINISHED_STATUSES.has(currentJob.status)) {
      if (Date.now() - start >= timeoutMs) {
        console.error(`Error: Timed out waiting for Job ${currentJob.id} to finish.`);
        process.exit(WAIT_TIMEOUT_EXIT_CODE);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      currentJob = reconcileLostJob(workspaceRoot, loadJobOrThrow(workspaceRoot, job.id));
    }

    const progressLines = readJobLogs(workspaceRoot, currentJob.id).slice(-10);
    if (options.json) {
      console.log(JSON.stringify({
        ...buildJobJsonPayload(currentJob),
        progress: progressLines
      }, null, 2));
    } else {
      process.stdout.write(renderJobDetail(currentJob, progressLines));
    }
    return;
  }

  if (targetJobId) {
    let job;
    try {
      job = findJob(workspaceRoot, targetJobId, {
        all: Boolean(options.all),
        sessionId: currentSessionId
      });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }

    const progressLines = readJobLogs(workspaceRoot, job.id).slice(-10);
    if (options.json) {
      console.log(JSON.stringify({
        ...buildJobJsonPayload(job),
        progress: progressLines
      }, null, 2));
    } else {
      process.stdout.write(renderJobDetail(job, progressLines));
    }
    return;
  }

  const jobs = listJobs(workspaceRoot, {
    all: Boolean(options.all),
    sessionId: currentSessionId
  });

  if (options.json) {
    const fullJobs = jobs.map((j) => loadJobOrThrow(workspaceRoot, j.id));
    console.log(JSON.stringify(fullJobs.map(buildJobJsonPayload), null, 2));
  } else {
    process.stdout.write(renderStatusTable(jobs));
  }
}

async function handleResult(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, RESULT_OPTION_CONFIG);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const { options, positionals } = parsed;
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const currentSessionId = process.env[SESSION_ID_ENV] || null;
  const targetJobId = positionals[0] || null;

  let job;
  try {
    if (targetJobId) {
      job = findJob(workspaceRoot, targetJobId, {
        all: Boolean(options.all),
        sessionId: currentSessionId
      });
    } else {
      job = findLatestFinishedJob(workspaceRoot, {
        all: Boolean(options.all),
        sessionId: currentSessionId
      });
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (!FINISHED_STATUSES.has(job.status)) {
    console.error(`Error: Job ${job.id} is not finished (status: ${job.status}).`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write(job.renderedOutput);
  }
}

async function handleCancel(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, CANCEL_OPTION_CONFIG);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const { options, positionals } = parsed;
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const currentSessionId = process.env[SESSION_ID_ENV] || null;
  const targetJobId = positionals[0] || null;

  let job;
  try {
    if (targetJobId) {
      job = findJob(workspaceRoot, targetJobId, {
        sessionId: currentSessionId
      });
    } else {
      job = findLatestActiveJob(workspaceRoot, {
        sessionId: currentSessionId
      });
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (FINISHED_STATUSES.has(job.status)) {
    console.error(`Error: Job ${job.id} is already finished (status: ${job.status}).`);
    process.exit(1);
  }

  if (job.processId) {
    terminateJobProcess(job.processId);
  }

  // The worker may have recorded its own cancellation, or newer fields, while it was being stopped.
  const latest = loadJob(workspaceRoot, job.id) ?? job;
  if (!FINISHED_STATUSES.has(latest.status)) {
    markJobCancelled(latest, workspaceRoot, "Job was cancelled.");
  }

  if (options.json) {
    console.log(JSON.stringify(buildJobJsonPayload(latest), null, 2));
  } else if (latest.status === "cancelled") {
    process.stdout.write(`Cancelled Job ${latest.id}.\n`);
  } else {
    process.stdout.write(`Job ${latest.id} finished (status: ${latest.status}) before it could be cancelled.\n`);
  }
}

async function handleReview(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, REVIEW_OPTION_CONFIG);
    assertWaitBackgroundExclusive(parsed.options);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const nonWhitespacePositionals = parsed.positionals.filter((p) => p.trim());
  if (nonWhitespacePositionals.length > 0) {
    console.error(`Unexpected argument: "${nonWhitespacePositionals[0]}". review takes no positional arguments.`);
    process.exit(1);
  }

  const invocationCwd = process.cwd();
  assertGitWorkspace(invocationCwd);

  const workspaceRoot = resolveWorkspaceRoot(invocationCwd);
  if (checkNoUncommittedChanges(workspaceRoot, parsed.options.json)) {
    return;
  }

  const isBackground = Boolean(parsed.options.background);
  const jobId = generateJobId("review");
  const currentSessionId = process.env[SESSION_ID_ENV] || null;

  const job = buildJobRecord({
    id: jobId,
    kind: "review",
    title: "Review uncommitted changes",
    command: "review",
    cwd: workspaceRoot,
    workspace: workspaceRoot,
    sessionId: currentSessionId,
    isBackground,
    readOnly: true,
    permission: "smart"
  });

  saveJob(workspaceRoot, job);

  if (isBackground) {
    launchBackgroundWorker(job, workspaceRoot, "Queued review of uncommitted changes", parsed.options.json);
    return;
  }

  appendJobLog(workspaceRoot, jobId, "Starting review of uncommitted changes");
  await runJobForeground(job, workspaceRoot, parsed.options.json);
}

function isBinary(buffer) {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// debt: naive threshold of 2000 changed lines and 200 KB diff text; replace with adaptive sizing once benchmarked
function evaluateChangeSize(text, extraLines = 0, extraBytes = 0) {
  const lines = (text ? text.split("\n").length : 0) + extraLines;
  const bytes = Buffer.byteLength(text || "", "utf8") + extraBytes;
  return {
    lines,
    bytes,
    isSmall: lines <= 2000 && bytes <= 200 * 1024
  };
}

function collectWorkingTreeChanges(workspaceRoot) {
  const untrackedStdout = execFileSync(
    "git",
    ["-C", workspaceRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  const untrackedFiles = untrackedStdout.split("\0").filter(Boolean);

  // If the repository has no commits yet, HEAD does not exist so diff against empty tree
  let trackedDiff = "";
  try {
    trackedDiff = execFileSync("git", ["-C", workspaceRoot, "diff", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    trackedDiff = execFileSync("git", ["-C", workspaceRoot, "diff"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  }

  const untrackedEntries = [];
  let untrackedLines = 0;
  let untrackedBytes = 0;

  for (const relPath of untrackedFiles) {
    const fullPath = path.resolve(workspaceRoot, relPath);
    try {
      // Symlinks can point outside the workspace; never send their target's content.
      if (fs.lstatSync(fullPath).isSymbolicLink()) {
        untrackedEntries.push({ path: relPath, isSymlink: true });
        continue;
      }
      const buf = fs.readFileSync(fullPath);
      if (isBinary(buf)) {
        untrackedEntries.push({ path: relPath, isBinary: true });
      } else {
        const content = buf.toString("utf8");
        const fileSize = evaluateChangeSize(content);
        if (!fileSize.isSmall) {
          untrackedEntries.push({ path: relPath, isOversized: true });
        } else {
          untrackedLines += fileSize.lines;
          untrackedBytes += fileSize.bytes;
          untrackedEntries.push({ path: relPath, content });
        }
      }
    } catch {
      untrackedEntries.push({ path: relPath, unreadable: true });
    }
  }

  const size = evaluateChangeSize(trackedDiff, untrackedLines, untrackedBytes);
  let diffOrContent = "";

  if (size.isSmall) {
    const parts = [];
    if (trackedDiff.trim()) {
      parts.push(`Tracked changes diff:\n${trackedDiff.trim()}`);
    }
    for (const u of untrackedEntries) {
      if (u.content !== undefined) {
        parts.push(`=== Untracked file: ${u.path} ===\n${u.content.trim()}`);
      } else if (u.isSymlink) {
        parts.push(`Untracked file (symlink): ${u.path}`);
      } else if (u.isBinary) {
        parts.push(`Untracked file (binary): ${u.path}`);
      } else if (u.isOversized) {
        parts.push(`Untracked file (oversized): ${u.path}`);
      } else {
        parts.push(`Untracked file (unreadable): ${u.path}`);
      }
    }
    diffOrContent = parts.join("\n\n");
  } else {
    // If no commits yet, diff --name-status against empty tree
    let nameStatus = "";
    try {
      nameStatus = execFileSync("git", ["-C", workspaceRoot, "diff", "--name-status", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      nameStatus = execFileSync("git", ["-C", workspaceRoot, "diff", "--name-status"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    }

    const changedFiles = [];
    if (nameStatus) changedFiles.push(nameStatus);
    for (const u of untrackedFiles) {
      changedFiles.push(`??\t${u}`);
    }

    diffOrContent = [
      `Changes exceed inline threshold (${size.lines} lines, ${Math.round(size.bytes / 1024)} KB).`,
      "Changed files:",
      changedFiles.join("\n"),
      "",
      "Use read-only git commands to inspect the changes:",
      "  git diff HEAD",
      "  git ls-files --others --exclude-standard"
    ].join("\n");
  }

  return {
    hasChanges: true,
    targetDescription: "Working tree uncommitted changes",
    diffOrContent
  };
}

function collectBranchChanges(workspaceRoot, baseRef) {
  try {
    execFileSync("git", ["-C", workspaceRoot, "rev-parse", "--verify", `${baseRef}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch {
    throw new Error(`Invalid base ref: "${baseRef}".`);
  }

  const branchDiff = execFileSync("git", ["-C", workspaceRoot, "diff", `${baseRef}...HEAD`], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });

  if (!branchDiff.trim()) {
    return { hasChanges: false, message: `No changes between ${baseRef} and HEAD.` };
  }

  const size = evaluateChangeSize(branchDiff);
  let diffOrContent = "";

  if (size.isSmall) {
    diffOrContent = `Branch diff (${baseRef}...HEAD):\n${branchDiff.trim()}`;
  } else {
    const nameStatus = execFileSync("git", ["-C", workspaceRoot, "diff", "--name-status", `${baseRef}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    diffOrContent = [
      `Changes exceed inline threshold (${size.lines} lines, ${Math.round(size.bytes / 1024)} KB).`,
      "Changed files:",
      nameStatus,
      "",
      "Use read-only git command to inspect the changes:",
      `  git diff ${baseRef}...HEAD`
    ].join("\n");
  }

  return {
    hasChanges: true,
    targetDescription: `Branch changes compared to base '${baseRef}' (${baseRef}...HEAD)`,
    diffOrContent
  };
}

function collectPlanChanges(invocationCwd, planPath) {
  const resolvedPlanPath = path.resolve(invocationCwd, planPath);
  let planContent;
  try {
    planContent = fs.readFileSync(resolvedPlanPath, "utf8");
  } catch {
    throw new Error(`Plan file "${planPath}" not found or unreadable.`);
  }

  const size = evaluateChangeSize(planContent);
  let diffOrContent = "";

  if (size.isSmall) {
    diffOrContent = `Plan document content:\n${planContent.trim()}`;
  } else {
    diffOrContent = [
      `Plan document exceeds inline threshold (${size.lines} lines, ${Math.round(size.bytes / 1024)} KB).`,
      "Read the full plan document using read-only tools at absolute path:",
      `  ${resolvedPlanPath}`
    ].join("\n");
  }

  return {
    hasChanges: true,
    targetDescription: `Plan document: ${planPath}`,
    diffOrContent
  };
}

async function handleAdversarialReview(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, ADVERSARIAL_REVIEW_OPTION_CONFIG);
    assertWaitBackgroundExclusive(parsed.options);
    if (parsed.options.base && parsed.options.plan) {
      throw new Error("Cannot combine --base and --plan (they are mutually exclusive).");
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const { options, positionals } = parsed;
  const focus = positionals.join(" ").trim();
  const invocationCwd = process.cwd();

  let targetInfo;
  let workspaceRoot;

  try {
    if (options.plan) {
      const inGit = isGitWorkspace(invocationCwd);
      workspaceRoot = inGit ? resolveWorkspaceRoot(invocationCwd) : invocationCwd;
      targetInfo = collectPlanChanges(invocationCwd, options.plan);
    } else if (options.base) {
      assertGitWorkspace(invocationCwd);
      workspaceRoot = resolveWorkspaceRoot(invocationCwd);
      targetInfo = collectBranchChanges(workspaceRoot, options.base);
    } else {
      assertGitWorkspace(invocationCwd);
      workspaceRoot = resolveWorkspaceRoot(invocationCwd);
      if (checkNoUncommittedChanges(workspaceRoot, options.json)) {
        return;
      }
      targetInfo = collectWorkingTreeChanges(workspaceRoot);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (!targetInfo.hasChanges) {
    if (options.json) {
      console.log(JSON.stringify({
        hasChanges: false,
        message: targetInfo.message
      }, null, 2));
    } else {
      console.log(targetInfo.message);
    }
    return;
  }

  const promptTemplatePath = path.resolve(__dirname, "../prompts/adversarial-review.md");
  const promptTemplate = fs.readFileSync(promptTemplatePath, "utf8");

  const prompt = promptTemplate
    .split("{{TARGET}}").join(targetInfo.targetDescription)
    .split("{{FOCUS}}").join(focus || "None")
    .split("{{DIFF_OR_CONTENT}}").join(targetInfo.diffOrContent);

  const schemaPath = path.resolve(__dirname, "../schemas/adversarial-review.json");
  const isBackground = Boolean(options.background);
  const jobId = generateJobId("adversarial-review");
  const currentSessionId = process.env[SESSION_ID_ENV] || null;

  const job = buildJobRecord({
    id: jobId,
    kind: "adversarial-review",
    title: `Adversarial review: ${targetInfo.targetDescription}`,
    prompt,
    cwd: workspaceRoot,
    workspace: workspaceRoot,
    sessionId: currentSessionId,
    isBackground,
    readOnly: true,
    permission: "smart",
    outputSchema: schemaPath
  });

  saveJob(workspaceRoot, job);

  if (isBackground) {
    launchBackgroundWorker(job, workspaceRoot, `Queued adversarial review of ${targetInfo.targetDescription}`, options.json);
    return;
  }

  appendJobLog(workspaceRoot, jobId, `Starting adversarial review of ${targetInfo.targetDescription}`);
  await runJobForeground(job, workspaceRoot, options.json);
}

const JOB_SUBCOMMANDS = new Set(["delegate", "resume-candidate", "status", "result", "cancel"]);

async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    process.exit(0);
  }

  if (JOB_SUBCOMMANDS.has(subcommand)) {
    reconcileLostJobs(resolveWorkspaceRoot(process.cwd()));
  }

  if (subcommand === "delegate") {
    await handleDelegate(argv.slice(1));
    return;
  }

  if (subcommand === "delegate-worker") {
    await handleDelegateWorker(argv.slice(1));
    return;
  }

  if (subcommand === "resume-candidate") {
    await handleResumeCandidate(argv.slice(1));
    return;
  }

  if (subcommand === "review") {
    await handleReview(argv.slice(1));
    return;
  }

  if (subcommand === "adversarial-review") {
    await handleAdversarialReview(argv.slice(1));
    return;
  }

  if (subcommand === "setup") {
    await handleSetup(argv.slice(1));
    return;
  }

  if (subcommand === "status") {
    await handleStatus(argv.slice(1));
    return;
  }

  if (subcommand === "result") {
    await handleResult(argv.slice(1));
    return;
  }

  if (subcommand === "cancel") {
    await handleCancel(argv.slice(1));
    return;
  }

  console.error(`Unknown subcommand: "${subcommand}"`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
