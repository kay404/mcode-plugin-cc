#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function escapeShellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function main() {
  const input = readStdin();
  let sessionId = null;
  if (input.trim()) {
    try {
      const parsed = JSON.parse(input);
      sessionId = parsed.session_id ?? null;
    } catch {
      // Ignore unparseable stdin
    }
  }

  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    return;
  }

  const exportsToAppend = [];
  if (sessionId) {
    exportsToAppend.push(`export MCODE_CLAUDE_SESSION_ID=${escapeShellSingleQuote(sessionId)}`);
  }
  if (process.env.CLAUDE_PLUGIN_DATA) {
    exportsToAppend.push(`export MCODE_PLUGIN_DATA=${escapeShellSingleQuote(process.env.CLAUDE_PLUGIN_DATA)}`);
  }

  if (exportsToAppend.length > 0) {
    fs.appendFileSync(envFile, exportsToAppend.join("\n") + "\n", "utf8");
  }
}

main();
