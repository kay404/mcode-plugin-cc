import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkVersions } from "../scripts/version-check.mjs";

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
  const version = checkVersions(ROOT_DIR);
  assert.equal(version, "0.1.0");

  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, ".claude-plugin/marketplace.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".claude-plugin/plugin.json"), "utf8"));

  assert.equal(marketplace.name, "mcode-plugin-cc");
  assert.equal(marketplace.plugins[0].name, "mcode");
  assert.equal(marketplace.plugins[0].source, "./plugins/mcode");
  assert.equal(plugin.name, "mcode");
  assert.equal(plugin.license, "MIT");
  assert.equal(plugin.author.name, "kay404");
});

test("version-sync check fails when manifests have mismatched versions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-version-check-test-"));
  try {
    const createFixtures = (overrides = {}) => {
      fs.mkdirSync(path.join(tempDir, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "plugins/mcode/.claude-plugin"), { recursive: true });

      const pkg = { name: "test-pkg", version: overrides.pkgVersion ?? "1.0.0" };
      const marketplace = {
        name: "test-marketplace",
        plugins: [{ name: "mcode", version: overrides.marketplacePluginVersion ?? "1.0.0" }]
      };
      if (overrides.marketplaceMetaVersion !== undefined) {
        marketplace.metadata = { version: overrides.marketplaceMetaVersion };
      }
      const plugin = { name: "mcode", version: overrides.pluginVersion ?? "1.0.0" };

      fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkg));
      fs.writeFileSync(path.join(tempDir, ".claude-plugin/marketplace.json"), JSON.stringify(marketplace));
      fs.writeFileSync(path.join(tempDir, "plugins/mcode/.claude-plugin/plugin.json"), JSON.stringify(plugin));
    };

    createFixtures({ pluginVersion: "1.0.1" });
    assert.throws(
      () => checkVersions(tempDir),
      /plugins\/mcode\/\.claude-plugin\/plugin\.json version \(1\.0\.1\) does not match package\.json \(1\.0\.0\)/
    );

    createFixtures({ marketplacePluginVersion: "1.0.2" });
    assert.throws(
      () => checkVersions(tempDir),
      /\.claude-plugin\/marketplace\.json plugin entry version \(1\.0\.2\) does not match package\.json \(1\.0\.0\)/
    );

    createFixtures({ marketplaceMetaVersion: "1.0.3" });
    assert.throws(
      () => checkVersions(tempDir),
      /\.claude-plugin\/marketplace\.json metadata version \(1\.0\.3\) does not match package\.json \(1\.0\.0\)/
    );

    createFixtures({ marketplaceMetaVersion: "1.0.0" });
    assert.equal(checkVersions(tempDir), "1.0.0");

    createFixtures();
    assert.equal(checkVersions(tempDir), "1.0.0");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("version-check script CLI exits 0 on match and 1 on mismatch", () => {
  const versionCheckScript = path.join(ROOT_DIR, "scripts/version-check.mjs");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-version-cli-test-"));
  try {
    fs.mkdirSync(path.join(tempDir, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "plugins/mcode/.claude-plugin"), { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    fs.writeFileSync(
      path.join(tempDir, ".claude-plugin/marketplace.json"),
      JSON.stringify({ plugins: [{ name: "mcode", version: "1.0.0" }] })
    );
    fs.writeFileSync(
      path.join(tempDir, "plugins/mcode/.claude-plugin/plugin.json"),
      JSON.stringify({ version: "2.0.0" })
    );

    const failRun = spawnSync(process.execPath, [versionCheckScript, tempDir], { encoding: "utf8" });
    assert.equal(failRun.status, 1);
    assert.match(failRun.stderr, /Version mismatch:/);

    const passRun = spawnSync(process.execPath, [versionCheckScript, ROOT_DIR], { encoding: "utf8" });
    assert.equal(passRun.status, 0);
    assert.match(passRun.stdout, /Version check passed: 0\.1\.0/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("version-check script rejects unknown flags", () => {
  const versionCheckScript = path.join(ROOT_DIR, "scripts/version-check.mjs");
  const run = spawnSync(process.execPath, [versionCheckScript, "--unknown"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown option: --unknown/);
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
  const implementedSubcommands = new Set(["delegate", "setup", "status", "result", "cancel", "resume-candidate"]);

  for (const filePath of ALL_PLUGIN_MARKDOWN_FILES) {
    const content = fs.readFileSync(filePath, "utf8");
    const subcmdMatches = content.matchAll(/mcode-companion\.mjs["']?\s+([a-zA-Z0-9_-]+)/g);
    for (const match of subcmdMatches) {
      const subcmd = match[1];
      assert.ok(
        implementedSubcommands.has(subcmd),
        `Referenced subcommand "${subcmd}" from ${path.basename(filePath)} is not implemented by companion script`
      );
    }
  }
});
