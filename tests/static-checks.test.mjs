import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT_DIR, "plugins/mcode");

function findMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

const ALL_PLUGIN_MARKDOWN_FILES = [
  ...findMarkdownFiles(path.join(PLUGIN_DIR, "commands")),
  ...findMarkdownFiles(path.join(PLUGIN_DIR, "agents")),
  ...findMarkdownFiles(path.join(PLUGIN_DIR, "skills"))
];

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

test("all plugin command, agent, and skill markdown files have valid frontmatter", () => {
  assert.ok(ALL_PLUGIN_MARKDOWN_FILES.length >= 4, "Expected at least 4 markdown files in plugin");

  for (const filePath of ALL_PLUGIN_MARKDOWN_FILES) {
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

test("companion subcommands referenced from markdown are implemented", () => {
  const implementedSubcommands = new Set(["delegate", "setup"]);

  for (const filePath of ALL_PLUGIN_MARKDOWN_FILES) {
    const content = fs.readFileSync(filePath, "utf8");
    const subcmdMatches = content.matchAll(/mcode-companion\.mjs\s+([a-zA-Z0-9_-]+)/g);
    for (const match of subcmdMatches) {
      const subcmd = match[1];
      assert.ok(
        implementedSubcommands.has(subcmd),
        `Referenced subcommand "${subcmd}" from ${path.basename(filePath)} is not implemented by companion script`
      );
    }
  }
});
