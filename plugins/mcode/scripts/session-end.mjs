#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { resolveWorkspaceRoot, cleanupSessionJobs } from "./lib/job-store.mjs";

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
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  cleanupSessionJobs(workspaceRoot, sessionId, { pluginDataDir });
}

main();
