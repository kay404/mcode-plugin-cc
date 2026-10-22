#!/usr/bin/env node

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
    if (!m || !m.path) continue;
    const target = path.resolve(process.cwd(), m.path);
    if (m.action === "create" || m.action === "modify" || m.action === "write") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, m.content ?? "mutated by fake mcode\n", "utf8");
    } else if (m.action === "delete") {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    }
  }
}

if (process.env.MCODE_MUTATIONS) {
  try {
    applyMutations(JSON.parse(process.env.MCODE_MUTATIONS));
  } catch {
    // Ignore invalid JSON
  }
}

if (process.env.MCODE_CREATE_FILE) {
  const [filePath, ...rest] = process.env.MCODE_CREATE_FILE.split(":");
  const content = rest.length ? rest.join(":") : "created by fake mcode\n";
  const target = path.resolve(process.cwd(), filePath.trim());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

if (process.env.MCODE_MODIFY_FILE) {
  const [filePath, ...rest] = process.env.MCODE_MODIFY_FILE.split(":");
  const content = rest.length ? rest.join(":") : "modified by fake mcode\n";
  const target = path.resolve(process.cwd(), filePath.trim());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

if (process.env.MCODE_DELETE_FILE) {
  const target = path.resolve(process.cwd(), process.env.MCODE_DELETE_FILE.trim());
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
}

const fixturePath = process.env.MCODE_FIXTURE;
if (fixturePath && fs.existsSync(fixturePath)) {
  const mutationCompanion = fixturePath.endsWith(".stream.jsonl")
    ? fixturePath.slice(0, -".stream.jsonl".length) + ".mutations.json"
    : fixturePath + ".mutations.json";
  if (fs.existsSync(mutationCompanion)) {
    try {
      applyMutations(JSON.parse(fs.readFileSync(mutationCompanion, "utf8")));
    } catch {
      // Ignore invalid JSON
    }
  }
  const streamData = fs.readFileSync(fixturePath, "utf8");
  process.stdout.write(streamData);
}

if (process.env.MCODE_STDERR) {
  process.stderr.write(process.env.MCODE_STDERR + "\n");
}

const exitCode = process.env.MCODE_EXIT_CODE ? parseInt(process.env.MCODE_EXIT_CODE, 10) : 0;
process.exit(exitCode);
