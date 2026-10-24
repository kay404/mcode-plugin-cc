#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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

if (process.env.MCODE_RECORD_PID) {
  fs.writeFileSync(process.env.MCODE_RECORD_PID, String(process.pid), "utf8");
}

function sleep() {
  const ms = parseInt(process.env.MCODE_SLEEP_MS, 10);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// When set, the first N fixture lines are emitted before sleeping, so a run can be observed mid-stream.
const sleepAfterLines = process.env.MCODE_SLEEP_AFTER_LINES
  ? parseInt(process.env.MCODE_SLEEP_AFTER_LINES, 10)
  : null;

if (process.env.MCODE_SLEEP_MS && sleepAfterLines === null) {
  sleep();
}

if (process.env.MCODE_FAIL_EXIT_CODE) {
  const code = parseInt(process.env.MCODE_FAIL_EXIT_CODE, 10) || 1;
  const stderrMsg = process.env.MCODE_STDERR || "Fake mcode execution error";
  process.stderr.write(stderrMsg + "\n");
  process.exit(code);
}

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write("0.6.12\n");
  process.exit(0);
}

if (argv[0] === "exec" && argv.includes("--help")) {
  process.stdout.write("Usage: mcode exec [options] [command] [prompt]\n");
  process.exit(0);
}

if (argv[0] === "provider" && argv[1] === "list") {
  const fixturePath = process.env.MCODE_PROVIDER_LIST_FIXTURE;
  if (fixturePath && fs.existsSync(fixturePath)) {
    process.stdout.write(fs.readFileSync(fixturePath, "utf8"));
  } else {
    const defaultFixture = path.join(__dirname, "../fixtures/provider-list.json");
    if (fs.existsSync(defaultFixture)) {
      process.stdout.write(fs.readFileSync(defaultFixture, "utf8"));
    }
  }
  process.exit(0);
}

function applyMutations(mutations) {
  if (!Array.isArray(mutations)) return;
  for (const m of mutations) {
    if (!m) continue;
    if (m.action === "git") {
      execFileSync("git", m.args ?? [], { cwd: process.cwd(), stdio: "ignore" });
      continue;
    }
    if (!m.path) continue;
    const target = path.resolve(process.cwd(), m.path);
    if (m.action === "create" || m.action === "modify") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, m.content ?? "mutated by fake mcode\n", "utf8");
    } else if (m.action === "delete") {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    } else if (m.action === "chmod") {
      if (fs.existsSync(target)) {
        fs.chmodSync(target, m.mode ?? 0o755);
      }
    }
  }
}

if (process.env.MCODE_MUTATIONS) {
  applyMutations(JSON.parse(process.env.MCODE_MUTATIONS));
}

const fixturePath = process.env.MCODE_FIXTURE;
if (fixturePath && fs.existsSync(fixturePath)) {
  const streamData = fs.readFileSync(fixturePath, "utf8");
  if (sleepAfterLines !== null) {
    const lines = streamData.split("\n");
    // writeSync: an async pipe write would not be flushed before the blocking sleep.
    fs.writeSync(1, lines.slice(0, sleepAfterLines).join("\n") + "\n");
    if (process.env.MCODE_SLEEP_MS) sleep();
    process.stdout.write(lines.slice(sleepAfterLines).join("\n"));
  } else {
    process.stdout.write(streamData);
  }
}

if (process.env.MCODE_STDERR) {
  process.stderr.write(process.env.MCODE_STDERR + "\n");
}

const exitCode = process.env.MCODE_EXIT_CODE ? parseInt(process.env.MCODE_EXIT_CODE, 10) : 0;
process.exitCode = exitCode;
