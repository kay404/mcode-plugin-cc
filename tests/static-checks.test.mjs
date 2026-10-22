import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT_DIR, "plugins/mcode");
const COMPANION_SCRIPT = path.join(PLUGIN_DIR, "scripts/mcode-companion.mjs");

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const lines = match[1].split("\n");
  const data = {};
  let currentKey = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && currentKey) {
      if (!Array.isArray(data[currentKey])) {
        data[currentKey] = [];
      }
      data[currentKey].push(trimmed.slice(2).trim());
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      currentKey = key;
      data[key] = val || [];
    }
  }

  return data;
}

test("manifests have matching versions and correct metadata", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, ".claude-plugin/marketplace.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".claude-plugin/plugin.json"), "utf8"));

  assert.equal(pkg.version, "0.1.0");
  assert.equal(marketplace.metadata.version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.name, "mcode-plugin-cc");
  assert.equal(marketplace.plugins[0].name, "mcode");
  assert.equal(marketplace.plugins[0].source, "./plugins/mcode");
  assert.equal(plugin.name, "mcode");
  assert.equal(plugin.license, "MIT");
  assert.equal(plugin.author.name, "kay404");
});

test("command, agent, and skill markdown files have valid frontmatter", () => {
  const markdownFiles = [
    path.join(PLUGIN_DIR, "commands/delegate.md"),
    path.join(PLUGIN_DIR, "agents/mcode-delegate.md"),
    path.join(PLUGIN_DIR, "skills/mcode-cli-runtime/SKILL.md"),
    path.join(PLUGIN_DIR, "skills/mcode-result-handling/SKILL.md")
  ];

  for (const filePath of markdownFiles) {
    assert.ok(fs.existsSync(filePath), `File should exist: ${filePath}`);
    const content = fs.readFileSync(filePath, "utf8");
    const fm = parseFrontmatter(content);
    assert.ok(fm, `Frontmatter missing or invalid in ${filePath}`);

    if (filePath.includes("/commands/")) {
      assert.ok(fm.description, `Command frontmatter missing description in ${filePath}`);
    } else if (filePath.includes("/agents/")) {
      assert.equal(fm.name, "mcode-delegate");
      assert.equal(fm.model, "sonnet");
      assert.ok(fm.tools.includes("Bash"));
    } else if (filePath.includes("/skills/")) {
      assert.ok(fm.name, `Skill frontmatter missing name in ${filePath}`);
      assert.equal(fm["user-invocable"], "false");
    }
  }
});

test("companion subcommands referenced from markdown exist in companion script", () => {
  const companionSource = fs.readFileSync(COMPANION_SCRIPT, "utf8");
  const markdownFiles = [
    path.join(PLUGIN_DIR, "commands/delegate.md"),
    path.join(PLUGIN_DIR, "agents/mcode-delegate.md"),
    path.join(PLUGIN_DIR, "skills/mcode-cli-runtime/SKILL.md"),
    path.join(PLUGIN_DIR, "skills/mcode-result-handling/SKILL.md")
  ];

  for (const filePath of markdownFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    const subcmdMatches = content.matchAll(/mcode-companion\.mjs\s+([a-zA-Z0-9_-]+)/g);
    for (const match of subcmdMatches) {
      const subcmd = match[1];
      const casePattern = new RegExp(`case\\s+["']${subcmd}["']`);
      assert.ok(
        casePattern.test(companionSource),
        `Referenced subcommand "${subcmd}" from ${path.basename(filePath)} must exist in companion script`
      );
    }
  }
});
