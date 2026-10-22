#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import {
  FINISHED_STATUSES,
  loadJob,
  loadState,
  resolveWorkspaceRoot,
  saveJob,
  terminateJobProcess
} from "./lib/job-store.mjs";
import { renderDelegationResult } from "./lib/render.mjs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const input = readStdin();
  let sessionId = null;
  if (input.trim()) {
    try {
      const parsed = JSON.parse(input);
      if (parsed.session_id) {
        sessionId = parsed.session_id;
      }
    } catch {
      // Ignore unparseable stdin
    }
  }

  if (!sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const storeOpts = { pluginDataDir: process.env.CLAUDE_PLUGIN_DATA };
  cancelSessionJobs(workspaceRoot, sessionId, storeOpts);
}

// Finished records are kept so --resume and result still work after `claude --continue`.
function cancelSessionJobs(workspaceRoot, sessionId, storeOpts) {
  const sessionItems = loadState(workspaceRoot, storeOpts).jobs
    .filter((item) => item.sessionId === sessionId && !FINISHED_STATUSES.has(item.status));

  for (const item of sessionItems) {
    const job = loadJob(workspaceRoot, item.id, storeOpts);
    if (!job || FINISHED_STATUSES.has(job.status)) continue;
    if (job.processId) {
      terminateJobProcess(job.processId);
    }
    job.status = "cancelled";
    job.reason = null;
    job.renderedOutput = renderDelegationResult(job);
    saveJob(workspaceRoot, job, storeOpts);
  }
}

main();
