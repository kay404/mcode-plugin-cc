import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const COMPANION_SCRIPT = path.join(ROOT_DIR, "plugins/mcode/scripts/mcode-companion.mjs");
const FAKE_MCODE = path.join(ROOT_DIR, "tests/helpers/fake-mcode.mjs");

function runCompanion(args, options = {}) {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-data-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-bin-"));

  if (!options.noMcodeOnPath && !options.useRealMcode) {
    const symlinkPath = path.join(binDir, "mcode");
    try {
      fs.symlinkSync(FAKE_MCODE, symlinkPath);
    } catch {
      fs.copyFileSync(FAKE_MCODE, symlinkPath);
      fs.chmodSync(symlinkPath, 0o755);
    }
  }

  const nodeDir = path.dirname(process.execPath);
  let pathEnv;
  if (options.useRealMcode) {
    pathEnv = process.env.PATH;
  } else if (options.noMcodeOnPath) {
    pathEnv = `${nodeDir}:/usr/bin:/bin`;
  } else {
    pathEnv = `${binDir}:${process.env.PATH}`;
  }

  const combinedEnv = {
    ...process.env,
    PATH: pathEnv,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    CLAUDE_SESSION_ID: "test-claude-session-setup",
    ...(options.env ?? {})
  };

  const result = spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: ROOT_DIR,
    env: combinedEnv,
    encoding: "utf8"
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

test("setup reports ready verdict, mcode version, and active provider in text mode", () => {
  const res = runCompanion(["setup"]);

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Verdict: ready"));
  assert.ok(res.stdout.includes("mcode version: 0.6.12"));
  assert.ok(res.stdout.includes("Active provider: minimax_oauth"));
  assert.equal(res.stderr, "");
});

test("setup reports ready verdict and complete checks in --json mode", () => {
  const res = runCompanion(["setup", "--json"]);

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.verdict, "ready");
  assert.equal(parsed.mcodeVersion, "0.6.12");
  assert.equal(parsed.activeProviderId, "minimax_oauth");
  assert.equal(parsed.nextStep, null);
  assert.equal(parsed.checks.node.ok, true);
  assert.equal(parsed.checks.mcode.ok, true);
  assert.equal(parsed.checks.mcode.version, "0.6.12");
  assert.equal(parsed.checks.headless.ok, true);
  assert.equal(parsed.checks.provider.ok, true);
  assert.equal(parsed.checks.provider.activeProviderId, "minimax_oauth");
});

test("missing mcode on PATH reports not-ready and official install command citing README", () => {
  const resText = runCompanion(["setup"], { noMcodeOnPath: true });

  assert.notEqual(resText.status, 0);
  assert.ok(resText.stdout.includes("Verdict: not-ready"));
  assert.ok(resText.stdout.includes("npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3 --registry=https://registry.npmjs.org/"));
  assert.ok(resText.stdout.includes("~/.minimax-code/releases/0.6.12/lib/node_modules/@minimax-ai/code/README.md"));

  const resJson = runCompanion(["setup", "--json"], { noMcodeOnPath: true });
  assert.notEqual(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "not-ready");
  assert.equal(parsed.mcodeVersion, null);
  assert.equal(parsed.checks.mcode.ok, false);
  assert.ok(parsed.nextStep.includes("npm install -g @minimax-ai/code"));
});

test("unsupported or old Node version reports not-ready and required range", () => {
  const resText = runCompanion(["setup"], {
    env: { MCODE_NODE_VERSION: "20.11.0" }
  });

  assert.notEqual(resText.status, 0);
  assert.ok(resText.stdout.includes("Verdict: not-ready"));
  assert.ok(resText.stdout.includes(">=22.19 <23 || >=24 <27"));

  const resJson = runCompanion(["setup", "--json"], {
    env: { MCODE_NODE_VERSION: "23.1.0" }
  });
  assert.notEqual(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "not-ready");
  assert.equal(parsed.checks.node.ok, false);
  assert.equal(parsed.checks.node.version, "23.1.0");
  assert.ok(parsed.nextStep.includes(">=22.19 <23 || >=24 <27"));
});

test("no usable provider suggests '! mcode login'", () => {
  const emptyProviders = JSON.stringify({
    minimaxModelSource: "token_plan",
    providers: []
  });

  const resEmpty = runCompanion(["setup"], {
    env: { MCODE_PROVIDER_LIST_JSON: emptyProviders }
  });
  assert.notEqual(resEmpty.status, 0);
  assert.ok(resEmpty.stdout.includes("Verdict: not-ready"));
  assert.ok(resEmpty.stdout.includes("! mcode login"));

  const unauthenticatedApiKey = JSON.stringify({
    minimaxModelSource: "minimax_api_key",
    providers: [
      {
        providerId: "minimax_api",
        kind: "minimax-api-key",
        active: true,
        enabled: true,
        hasApiKey: false
      }
    ]
  });

  const resApiKey = runCompanion(["setup", "--json"], {
    env: { MCODE_PROVIDER_LIST_JSON: unauthenticatedApiKey }
  });
  assert.notEqual(resApiKey.status, 0);
  const parsed = JSON.parse(resApiKey.stdout);
  assert.equal(parsed.verdict, "not-ready");
  assert.equal(parsed.checks.provider.ok, false);
  assert.equal(parsed.nextStep, "! mcode login");
});

test("provider check never leaks maskedApiKey or baseUrl into output", () => {
  const providerListWithSecrets = JSON.stringify({
    minimaxModelSource: "token_plan",
    providers: [
      {
        providerId: "custom_provider:leaky",
        kind: "custom",
        active: true,
        enabled: true,
        hasApiKey: true,
        maskedApiKey: "sk-SECRET-MASKED-KEY-XYZ",
        baseUrl: "https://secret-base-url.internal.domain.com/v1"
      }
    ]
  });

  const resText = runCompanion(["setup"], {
    env: { MCODE_PROVIDER_LIST_JSON: providerListWithSecrets }
  });
  assert.equal(resText.status, 0);
  assert.ok(!resText.stdout.includes("sk-SECRET-MASKED-KEY-XYZ"));
  assert.ok(!resText.stdout.includes("secret-base-url"));
  assert.ok(!resText.stderr.includes("sk-SECRET-MASKED-KEY-XYZ"));
  assert.ok(!resText.stderr.includes("secret-base-url"));

  const resJson = runCompanion(["setup", "--json"], {
    env: { MCODE_PROVIDER_LIST_JSON: providerListWithSecrets }
  });
  assert.equal(resJson.status, 0);
  assert.ok(!resJson.stdout.includes("sk-SECRET-MASKED-KEY-XYZ"));
  assert.ok(!resJson.stdout.includes("secret-base-url"));
  assert.ok(!resJson.stderr.includes("sk-SECRET-MASKED-KEY-XYZ"));
  assert.ok(!resJson.stderr.includes("secret-base-url"));
});

test("setup rejects unsupported options with clear hint", () => {
  const res = runCompanion(["setup", "--unknown-flag"]);

  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("Unsupported option: --unknown-flag"));
  assert.ok(res.stderr.includes("Supported options: --json"));
});

test("setup verifies against the real mcode on this machine", () => {
  const res = runCompanion(["setup"], { useRealMcode: true });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Verdict: ready"));
  assert.ok(res.stdout.includes("mcode version: 0.6.12"));
  assert.ok(res.stdout.includes("Active provider: minimax_oauth"));

  const resJson = runCompanion(["setup", "--json"], { useRealMcode: true });
  assert.equal(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "ready");
  assert.equal(parsed.mcodeVersion, "0.6.12");
  assert.equal(parsed.activeProviderId, "minimax_oauth");
});
