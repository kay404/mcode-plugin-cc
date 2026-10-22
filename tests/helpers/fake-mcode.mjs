#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (process.env.MCODE_RECORD_ARGV) {
  fs.writeFileSync(process.env.MCODE_RECORD_ARGV, JSON.stringify(argv, null, 2), "utf8");
}

if (process.env.MCODE_RECORD_CWD) {
  fs.writeFileSync(process.env.MCODE_RECORD_CWD, process.cwd(), "utf8");
}

let stdinData = "";
try {
  stdinData = fs.readFileSync(0, "utf8");
} catch {
  // Stdin closed or not available
}

if (process.env.MCODE_RECORD_STDIN) {
  fs.writeFileSync(process.env.MCODE_RECORD_STDIN, stdinData, "utf8");
}

if (process.env.MCODE_FAIL_EXIT_CODE) {
  const code = parseInt(process.env.MCODE_FAIL_EXIT_CODE, 10) || 1;
  const stderrMsg = process.env.MCODE_STDERR || "Fake mcode execution error";
  process.stderr.write(stderrMsg + "\n");
  process.exit(code);
}

if (argv.length === 1 && argv[0] === "--version") {
  if (process.env.MCODE_VERSION_FIXTURE && fs.existsSync(process.env.MCODE_VERSION_FIXTURE)) {
    process.stdout.write(fs.readFileSync(process.env.MCODE_VERSION_FIXTURE, "utf8"));
  } else {
    process.stdout.write((process.env.MCODE_VERSION || "0.6.12") + "\n");
  }
  process.exit(process.env.MCODE_EXIT_CODE ? parseInt(process.env.MCODE_EXIT_CODE, 10) : 0);
}

if (argv[0] === "exec" && argv.includes("--help")) {
  if (process.env.MCODE_EXEC_HELP_FIXTURE && fs.existsSync(process.env.MCODE_EXEC_HELP_FIXTURE)) {
    process.stdout.write(fs.readFileSync(process.env.MCODE_EXEC_HELP_FIXTURE, "utf8"));
  } else {
    process.stdout.write("Usage: mcode exec [options] [command] [prompt]\n");
  }
  process.exit(process.env.MCODE_EXIT_CODE ? parseInt(process.env.MCODE_EXIT_CODE, 10) : 0);
}

if (argv[0] === "provider" && argv[1] === "list") {
  if (process.env.MCODE_PROVIDER_LIST_FIXTURE && fs.existsSync(process.env.MCODE_PROVIDER_LIST_FIXTURE)) {
    process.stdout.write(fs.readFileSync(process.env.MCODE_PROVIDER_LIST_FIXTURE, "utf8"));
  } else if (process.env.MCODE_PROVIDER_LIST_JSON) {
    process.stdout.write(process.env.MCODE_PROVIDER_LIST_JSON + "\n");
  } else {
    const defaultFixture = path.join(__dirname, "../fixtures/provider-list.json");
    if (fs.existsSync(defaultFixture)) {
      process.stdout.write(fs.readFileSync(defaultFixture, "utf8"));
    } else {
      process.stdout.write(JSON.stringify({
        minimaxModelSource: "token_plan",
        providers: [
          {
            providerId: "minimax_oauth",
            kind: "minimax-oauth",
            active: true,
            enabled: true,
            hasApiKey: false
          }
        ]
      }, null, 2) + "\n");
    }
  }
  process.exit(process.env.MCODE_EXIT_CODE ? parseInt(process.env.MCODE_EXIT_CODE, 10) : 0);
}

const fixturePath = process.env.MCODE_FIXTURE;
if (fixturePath && fs.existsSync(fixturePath)) {
  const streamData = fs.readFileSync(fixturePath, "utf8");
  process.stdout.write(streamData);
}

if (process.env.MCODE_STDERR) {
  process.stderr.write(process.env.MCODE_STDERR + "\n");
}

const exitCode = process.env.MCODE_EXIT_CODE ? parseInt(process.env.MCODE_EXIT_CODE, 10) : 0;
process.exit(exitCode);
