#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

if (process.env.MCODE_FAIL_EXIT_CODE) {
  const code = parseInt(process.env.MCODE_FAIL_EXIT_CODE, 10) || 1;
  const stderrMsg = process.env.MCODE_STDERR || "Fake mcode execution error";
  process.stderr.write(stderrMsg + "\n");
  process.exit(code);
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
  process.stdout.write(streamData);
}

if (process.env.MCODE_STDERR) {
  process.stderr.write(process.env.MCODE_STDERR + "\n");
}

const exitCode = process.env.MCODE_EXIT_CODE ? parseInt(process.env.MCODE_EXIT_CODE, 10) : 0;
process.exit(exitCode);
