#!/usr/bin/env node

import process from "node:process";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  generateJobId,
  saveJob,
  appendJobLog,
  resolveWorkspaceRoot
} from "./lib/job-store.mjs";
import { runMcode, wrapReadOnlyPrompt } from "./lib/mcode-runner.mjs";
import { renderDelegationResult, buildJobJsonPayload } from "./lib/render.mjs";

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/mcode-companion.mjs delegate [options] [task]",
    "  node scripts/mcode-companion.mjs setup [--json]",
    "  node scripts/mcode-companion.mjs review [--wait|--background] [--base <ref>]",
    "  node scripts/mcode-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--plan <path>] [focus]",
    "  node scripts/mcode-companion.mjs status [job-id] [--all] [--json]",
    "  node scripts/mcode-companion.mjs result [job-id] [--json]",
    "  node scripts/mcode-companion.mjs cancel [job-id] [--json]"
  ].join("\n"));
}

async function handleDelegate(rawTokens) {
  const { options, positionals } = parseArgs(rawTokens, {
    valueOptions: ["model", "effort", "session", "raw-arguments"],
    booleanOptions: ["json", "full", "read-only", "background", "resume", "fresh"]
  });

  let effectiveOptions = { ...options };
  let effectivePositionals = [...positionals];

  if (options["raw-arguments"]) {
    const splitTokens = splitRawArgumentString(options["raw-arguments"]);
    const parsedRaw = parseArgs(splitTokens, {
      valueOptions: ["model", "effort", "session"],
      booleanOptions: ["json", "full", "read-only", "background", "resume", "fresh"]
    });
    effectiveOptions = { ...effectiveOptions, ...parsedRaw.options };
    effectivePositionals = [...effectivePositionals, ...parsedRaw.positionals];
  }

  const prompt = effectivePositionals.join(" ").trim();
  if (!prompt) {
    console.error("Error: Task prompt is required for delegation.");
    process.exit(1);
  }

  const permission = effectiveOptions.full ? "full" : "smart";
  const readOnly = Boolean(effectiveOptions["read-only"]);
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
    model: effectiveOptions.model ?? null,
    effort: effectiveOptions.effort ?? null,
    mcodeSessionId: effectiveOptions.session ?? null,
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
      model: effectiveOptions.model,
      effort: effectiveOptions.effort,
      session: effectiveOptions.session,
      prompt: mcodePrompt,
      onProgress: (line) => {
        appendJobLog(workspaceRoot, jobId, line);
        if (!effectiveOptions.json) {
          process.stderr.write(`[mcode] ${line}\n`);
        }
      }
    });
  } catch (err) {
    outcome = {
      status: "failed",
      reason: err.reason || (err.code === "ENOENT" ? "mcode-not-found" : "error"),
      output: null,
      error: { message: err.message },
      mcodeSessionId: effectiveOptions.session ?? null,
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

  if (effectiveOptions.json) {
    console.log(JSON.stringify(buildJobJsonPayload(job), null, 2));
  } else {
    process.stdout.write(renderDelegationResult(job));
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

  const subArgs = argv.slice(1);

  switch (subcommand) {
    case "delegate":
      await handleDelegate(subArgs);
      break;
    case "setup":
    case "review":
    case "adversarial-review":
    case "status":
    case "result":
    case "cancel":
    case "delegate-worker":
    case "resume-candidate":
      console.error(`Subcommand "${subcommand}" is reserved for subsequent tickets.`);
      process.exit(1);
      break;
    default:
      console.error(`Unknown subcommand: "${subcommand}"`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
