#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  parseArgs,
  DELEGATE_OPTION_CONFIG,
  DELEGATE_WORKER_OPTION_CONFIG,
  SETUP_OPTION_CONFIG,
  RESUME_CANDIDATE_OPTION_CONFIG,
  STATUS_OPTION_CONFIG,
  RESULT_OPTION_CONFIG,
  CANCEL_OPTION_CONFIG,
  REVIEW_OPTION_CONFIG
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
  formatAge
} from "./lib/render.mjs";
import { runSetupChecks, renderSetupResult } from "./lib/setup.mjs";
import { captureWorkspaceSnapshot, evaluateWorkspaceGuard, isGitWorkspace } from "./lib/workspace-guard.mjs";

const SESSION_ID_ENV = "MCODE_CLAUDE_SESSION_ID";

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/mcode-companion.mjs delegate [--read-only] [--full] [--resume] [--fresh] [--model <model>] [--effort <effort>] [--json] <task>",
    "  node scripts/mcode-companion.mjs resume-candidate [--json]",
    "  node scripts/mcode-companion.mjs review [--wait] [--background] [--json]",
    "  node scripts/mcode-companion.mjs setup [--json]",
    "  node scripts/mcode-companion.mjs status [job-id] [--all] [--json]",
    "  node scripts/mcode-companion.mjs result [job-id] [--all] [--json]",
    "  node scripts/mcode-companion.mjs cancel [job-id] [--json]"
  ].join("\n"));
}

function splitSubcommandArgs(rawArgs) {
  if (rawArgs.length === 1) {
    return rawArgs[0].trim().split(/\s+/).filter(Boolean);
  }
  return rawArgs;
}

async function executeDelegation(job, workspaceRoot, invocationCwd, onProgress = () => {}) {
  const readOnly = job.readOnly;
  const snapshotBefore = readOnly ? captureWorkspaceSnapshot(workspaceRoot) : null;
  const mcodePrompt = readOnly ? wrapReadOnlyPrompt(job.prompt) : job.prompt;

  let outcome;
  try {
    outcome = await runMcode({
      cwd: invocationCwd,
      permission: job.permission,
      model: job.model,
      effort: job.effort,
      session: job.mcodeSessionId || undefined,
      prompt: mcodePrompt,
      onProgress
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

  job.status = outcome.status;
  job.reason = outcome.reason;
  job.output = outcome.output;
  job.error = outcome.error;
  job.usage = outcome.usage || null;
  if (outcome.mcodeSessionId) {
    job.mcodeSessionId = outcome.mcodeSessionId;
  }
  job.stderr = outcome.stderr;
  job.renderedOutput = renderDelegationResult(job);

  saveJob(workspaceRoot, job);
  appendJobLog(workspaceRoot, job.id, `Completed with status ${job.status}${job.reason ? ` (${job.reason})` : ""}`);

  return outcome;
}

async function executeReview(job, workspaceRoot, invocationCwd, onProgress = () => {}) {
  const snapshotBefore = captureWorkspaceSnapshot(workspaceRoot);

  let outcome;
  try {
    outcome = await runMcode({
      command: "review",
      cwd: workspaceRoot,
      permission: job.permission,
      onProgress
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

  job.readOnlyGuard = evaluateWorkspaceGuard(snapshotBefore, workspaceRoot);
  if (job.readOnlyGuard.changedPaths.length > 0 || job.readOnlyGuard.headMoved || job.readOnlyGuard.stashChanged) {
    appendJobLog(
      workspaceRoot,
      job.id,
      `Read-only violation detected: ${job.readOnlyGuard.changedPaths.join(", ")}`
    );
  }

  job.status = outcome.status;
  job.reason = outcome.reason;
  job.output = outcome.output;
  job.error = outcome.error;
  job.usage = outcome.usage || null;
  if (outcome.mcodeSessionId) {
    job.mcodeSessionId = outcome.mcodeSessionId;
  }
  job.stderr = outcome.stderr;
  job.renderedOutput = renderDelegationResult(job);

  saveJob(workspaceRoot, job);
  appendJobLog(workspaceRoot, job.id, `Completed with status ${job.status}${job.reason ? ` (${job.reason})` : ""}`);

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
  const createdAt = new Date().toISOString();

  const isBackground = Boolean(options.background);

  const job = {
    id: jobId,
    kind: "delegate",
    title: prompt,
    prompt,
    cwd: invocationCwd,
    workspace: workspaceRoot,
    sessionId: currentSessionId,
    processId: isBackground ? null : process.pid,
    readOnly,
    permission,
    model: options.model || null,
    effort: options.effort || null,
    mcodeSessionId: targetMcodeSessionId || null,
    status: isBackground ? "queued" : "running",
    reason: null,
    output: null,
    renderedOutput: null,
    error: null,
    usage: null,
    readOnlyGuard: null,
    createdAt,
    updatedAt: createdAt
  };

  saveJob(workspaceRoot, job);

  if (isBackground) {
    appendJobLog(workspaceRoot, jobId, `Queued delegation: "${prompt.slice(0, 80)}"`);

    const companionScript = path.resolve(process.argv[1]);
    const worker = spawn(process.execPath, [
      companionScript,
      "delegate-worker",
      "--job-id",
      jobId
    ], {
      cwd: invocationCwd,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    worker.unref();

    if (options.json) {
      console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
    } else {
      process.stdout.write([
        `Job ${jobId} started in the background.`,
        "",
        `To check progress:  /mcode:status ${jobId}`,
        `To read results:    /mcode:result ${jobId}`,
        `To cancel:          /mcode:cancel ${jobId}`,
        ""
      ].join("\n"));
    }
    return;
  }

  appendJobLog(workspaceRoot, jobId, `Starting delegation: "${prompt.slice(0, 80)}"`);

  const outcome = await executeDelegation(job, workspaceRoot, invocationCwd, (line) => {
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

  const invocationCwd = job.cwd || job.workspace;
  if (job.kind === "review") {
    await executeReview(job, workspaceRoot, invocationCwd, (line) => {
      appendJobLog(workspaceRoot, jobId, line);
    });
  } else {
    await executeDelegation(job, workspaceRoot, invocationCwd, (line) => {
      appendJobLog(workspaceRoot, jobId, line);
    });
  }
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
      console.log(`Resume candidate: ${candidate.id} (${candidate.mcodeSessionId})\n  Title: ${candidate.title}\n  Age: ${formatAge(candidate.createdAt)}`);
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
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      currentJob = loadJobOrThrow(workspaceRoot, job.id);
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

  job.status = "cancelled";
  job.reason = null;
  job.renderedOutput = renderDelegationResult(job);

  saveJob(workspaceRoot, job);
  appendJobLog(workspaceRoot, job.id, "Job was cancelled.");

  if (options.json) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write(`Cancelled Job ${job.id}.\n`);
  }
}

async function handleReview(rawTokens) {
  let parsed;
  try {
    const tokens = splitSubcommandArgs(rawTokens);
    parsed = parseArgs(tokens, REVIEW_OPTION_CONFIG);
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
  if (!isGitWorkspace(invocationCwd)) {
    console.error("Error: Not a git repository.");
    process.exit(1);
  }

  const workspaceRoot = resolveWorkspaceRoot(invocationCwd);

  let statusOutput;
  try {
    statusOutput = execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    console.error("Error: git status failed.");
    process.exit(1);
  }

  if (!statusOutput.trim()) {
    if (parsed.options.json) {
      console.log(JSON.stringify({
        hasChanges: false,
        message: "No uncommitted changes to review."
      }, null, 2));
    } else {
      console.log("No uncommitted changes to review.");
    }
    return;
  }

  const isBackground = Boolean(parsed.options.background);
  const jobId = generateJobId("review");
  const createdAt = new Date().toISOString();
  const currentSessionId = process.env[SESSION_ID_ENV] || null;

  const job = {
    id: jobId,
    kind: "review",
    title: "Review uncommitted changes",
    prompt: null,
    cwd: invocationCwd,
    workspace: workspaceRoot,
    sessionId: currentSessionId,
    processId: isBackground ? null : process.pid,
    readOnly: true,
    permission: "smart",
    model: null,
    effort: null,
    mcodeSessionId: null,
    status: isBackground ? "queued" : "running",
    reason: null,
    output: null,
    renderedOutput: null,
    error: null,
    usage: null,
    readOnlyGuard: null,
    createdAt,
    updatedAt: createdAt
  };

  saveJob(workspaceRoot, job);

  if (isBackground) {
    appendJobLog(workspaceRoot, jobId, "Queued review of uncommitted changes");

    const companionScript = path.resolve(process.argv[1]);
    const worker = spawn(process.execPath, [
      companionScript,
      "delegate-worker",
      "--job-id",
      jobId
    ], {
      cwd: invocationCwd,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    worker.unref();

    if (parsed.options.json) {
      console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
    } else {
      process.stdout.write([
        `Job ${jobId} started in the background.`,
        "",
        `To check progress:  /mcode:status ${jobId}`,
        `To read results:    /mcode:result ${jobId}`,
        `To cancel:          /mcode:cancel ${jobId}`,
        ""
      ].join("\n"));
    }
    return;
  }

  appendJobLog(workspaceRoot, jobId, "Starting review of uncommitted changes");

  const outcome = await executeReview(job, workspaceRoot, invocationCwd, (line) => {
    appendJobLog(workspaceRoot, jobId, line);
    if (!parsed.options.json) {
      process.stderr.write(`[mcode] ${line}\n`);
    }
  });

  if (parsed.options.json) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write(job.renderedOutput);
  }

  if (job.status !== "completed") {
    process.exit(outcome.exitCode && outcome.exitCode !== 0 ? outcome.exitCode : 1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    process.exit(0);
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
