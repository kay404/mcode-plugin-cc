#!/usr/bin/env node

import process from "node:process";
import {
  parseArgs,
  DELEGATE_OPTION_CONFIG,
  SETUP_OPTION_CONFIG,
  STATUS_OPTION_CONFIG,
  RESULT_OPTION_CONFIG
} from "./lib/args.mjs";
import {
  generateJobId,
  saveJob,
  loadJobOrThrow,
  readJobLogs,
  listJobs,
  findJob,
  findLatestFinishedJob,
  appendJobLog,
  resolveWorkspaceRoot,
  FINISHED_STATUSES
} from "./lib/job-store.mjs";
import { runMcode, wrapReadOnlyPrompt } from "./lib/mcode-runner.mjs";
import {
  renderDelegationResult,
  renderStatusTable,
  renderJobDetail,
  buildJobJsonPayload
} from "./lib/render.mjs";
import { runSetupChecks, renderSetupResult } from "./lib/setup.mjs";
import { captureWorkspaceSnapshot, evaluateWorkspaceGuard } from "./lib/workspace-guard.mjs";

const SESSION_ID_ENV = "MCODE_CLAUDE_SESSION_ID";

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/mcode-companion.mjs delegate [--read-only] [--full] [--model <model>] [--effort <effort>] [--json] <task>",
    "  node scripts/mcode-companion.mjs setup [--json]",
    "  node scripts/mcode-companion.mjs status [job-id] [--all] [--json]",
    "  node scripts/mcode-companion.mjs result [job-id] [--all] [--json]"
  ].join("\n"));
}

function splitSubcommandArgs(rawArgs) {
  if (rawArgs.length === 1) {
    return rawArgs[0].trim().split(/\s+/).filter(Boolean);
  }
  return rawArgs;
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

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.error("Error: Task prompt is required for delegation.");
    process.exit(1);
  }

  const permission = options.full ? "full" : "smart";
  const readOnly = Boolean(options["read-only"]);
  const mcodePrompt = readOnly ? wrapReadOnlyPrompt(prompt) : prompt;

  const invocationCwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(invocationCwd);
  const jobId = generateJobId("delegate");
  const createdAt = new Date().toISOString();

  const snapshotBefore = readOnly ? captureWorkspaceSnapshot(workspaceRoot) : null;

  const job = {
    id: jobId,
    kind: "delegate",
    title: prompt,
    prompt,
    workspace: workspaceRoot,
    sessionId: process.env[SESSION_ID_ENV] || null,
    processId: process.pid,
    readOnly,
    permission,
    model: options.model || null,
    effort: options.effort || null,
    mcodeSessionId: null,
    status: "running",
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
  appendJobLog(workspaceRoot, jobId, `Starting delegation: "${prompt.slice(0, 80)}"`);

  let outcome;
  try {
    outcome = await runMcode({
      cwd: invocationCwd,
      permission,
      model: options.model,
      effort: options.effort,
      prompt: mcodePrompt,
      onProgress: (line) => {
        appendJobLog(workspaceRoot, jobId, line);
        if (!options.json) {
          process.stderr.write(`[mcode] ${line}\n`);
        }
      }
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

  if (readOnly) {
    job.readOnlyGuard = evaluateWorkspaceGuard(snapshotBefore, workspaceRoot);
    if (job.readOnlyGuard.changedPaths.length > 0 || job.readOnlyGuard.headMoved || job.readOnlyGuard.stashChanged) {
      appendJobLog(
        workspaceRoot,
        jobId,
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
  appendJobLog(workspaceRoot, jobId, `Completed with status ${job.status}${job.reason ? ` (${job.reason})` : ""}`);

  if (options.json) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write(renderDelegationResult(job));
  }

  if (job.status !== "completed") {
    process.exit(outcome.exitCode && outcome.exitCode !== 0 ? outcome.exitCode : 1);
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

  console.error(`Unknown subcommand: "${subcommand}"`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
