#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

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

if (process.env.MCODE_SLEEP_MS) {
  const ms = parseInt(process.env.MCODE_SLEEP_MS, 10);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (process.env.MCODE_FAIL_EXIT_CODE) {
  const code = parseInt(process.env.MCODE_FAIL_EXIT_CODE, 10) || 1;
  const stderrMsg = process.env.MCODE_STDERR || "Fake mcode execution error";
  process.stderr.write(stderrMsg + "\n");
  process.exit(code);
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
