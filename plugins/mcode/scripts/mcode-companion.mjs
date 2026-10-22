#!/usr/bin/env node

import process from "node:process";
import { parseArgs, DELEGATE_OPTION_CONFIG, SETUP_OPTION_CONFIG } from "./lib/args.mjs";
import {
  generateJobId,
  saveJob,
  appendJobLog,
  resolveWorkspaceRoot
} from "./lib/job-store.mjs";
import { runMcode, wrapReadOnlyPrompt } from "./lib/mcode-runner.mjs";
import { renderDelegationResult, buildJobJsonPayload } from "./lib/render.mjs";
import { runSetupChecks, renderSetupResult } from "./lib/setup.mjs";

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/mcode-companion.mjs delegate [--read-only] [--full] [--model <model>] [--effort <effort>] [--json] <task>",
    "  node scripts/mcode-companion.mjs setup [--json]"
  ].join("\n"));
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

  const job = {
    id: jobId,
    kind: "delegate",
    prompt,
    workspace: workspaceRoot,
    sessionId: process.env.CLAUDE_SESSION_ID ?? null,
    readOnly,
    permission,
    model: options.model ?? null,
    effort: options.effort ?? null,
    mcodeSessionId: null,
    status: "running",
    reason: null,
    output: null,
    error: null,
    usage: null,
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
      mcodeSessionId: err.sessionId ?? null,
      exitCode: 1,
      stderr: err.message
    };
  }

  job.status = outcome.status;
  job.reason = outcome.reason;
  job.output = outcome.output;
  job.error = outcome.error;
  job.usage = outcome.usage ?? null;
  if (outcome.mcodeSessionId) {
    job.mcodeSessionId = outcome.mcodeSessionId;
  }
  job.stderr = outcome.stderr;

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
    parsed = parseArgs(rawTokens, SETUP_OPTION_CONFIG);
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

  if (result.verdict !== "ready") {
    process.exit(1);
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

  console.error(`Unknown subcommand: "${subcommand}"`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
