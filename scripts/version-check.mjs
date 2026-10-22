import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function checkVersions(rootDir) {
  const resolvedRoot = path.resolve(rootDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const pkgPath = path.join(resolvedRoot, "package.json");
  const marketplacePath = path.join(resolvedRoot, ".claude-plugin/marketplace.json");
  const pluginPath = path.join(resolvedRoot, "plugins/mcode/.claude-plugin/plugin.json");

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));

  const targetVersion = pkg.version;
  if (!targetVersion) {
    throw new Error("package.json is missing a version field");
  }

  const mismatches = [];

  const marketplacePlugin = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.find((p) => p.name === "mcode") ?? marketplace.plugins[0]
    : null;

  if (!marketplacePlugin?.version) {
    mismatches.push(".claude-plugin/marketplace.json plugin entry is missing a version");
  } else if (marketplacePlugin.version !== targetVersion) {
    mismatches.push(
      `.claude-plugin/marketplace.json plugin entry version (${marketplacePlugin.version}) does not match package.json (${targetVersion})`
    );
  }

  if (marketplace.metadata?.version !== undefined && marketplace.metadata.version !== targetVersion) {
    mismatches.push(
      `.claude-plugin/marketplace.json metadata version (${marketplace.metadata.version}) does not match package.json (${targetVersion})`
    );
  }

  if (!plugin.version) {
    mismatches.push("plugins/mcode/.claude-plugin/plugin.json is missing a version");
  } else if (plugin.version !== targetVersion) {
    mismatches.push(
      `plugins/mcode/.claude-plugin/plugin.json version (${plugin.version}) does not match package.json (${targetVersion})`
    );
  }

  if (mismatches.length > 0) {
    throw new Error(`Version mismatch:\n${mismatches.map((m) => `  - ${m}`).join("\n")}`);
  }

  return targetVersion;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    console.log("Usage: node scripts/version-check.mjs [directory]");
    process.exit(0);
  }
  if (arg?.startsWith("-")) {
    console.error(`Unknown option: ${arg}\nSupported options: --help, -h`);
    process.exit(1);
  }

  try {
    const version = checkVersions(arg);
    console.log(`Version check passed: ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
