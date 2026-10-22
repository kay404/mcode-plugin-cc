import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isNodeVersionSupported } from "../plugins/mcode/scripts/lib/setup.mjs";
import { runCompanion, makeTempDir } from "./helpers/run-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

test("node version range check pure function covers required bounds", () => {
  assert.equal(isNodeVersionSupported("22.18.0"), false);
  assert.equal(isNodeVersionSupported("22.19.0"), true);
  assert.equal(isNodeVersionSupported("22.20.1"), true);
  assert.equal(isNodeVersionSupported("23.0.0"), false);
  assert.equal(isNodeVersionSupported("23.9.0"), false);
  assert.equal(isNodeVersionSupported("24.0.0"), true);
  assert.equal(isNodeVersionSupported("26.1.0"), true);
  assert.equal(isNodeVersionSupported("27.0.0"), false);
});

test("setup reports ready when key provider only is active", () => {
  const res = runCompanion(["setup"], {
    env: {
      MCODE_PROVIDER_LIST_FIXTURE: path.join(FIXTURES_DIR, "provider-list-key-only.json")
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Verdict: ready"));
  assert.ok(res.stdout.includes("mcode version: 0.6.12"));
  assert.ok(res.stdout.includes("custom_provider:magpie (verified)"));
  assert.ok(!res.stdout.includes("login unverified"));
});

test("setup reports ready (login unverified) when only OAuth provider is active", () => {
  const res = runCompanion(["setup"], {
    env: {
      MCODE_PROVIDER_LIST_FIXTURE: path.join(FIXTURES_DIR, "provider-list-oauth-only.json")
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Verdict: ready (login unverified)"));
  assert.ok(res.stdout.includes("minimax_oauth (unverified (login not checked))"));
  assert.ok(res.stdout.includes("! mcode login"));

  const resJson = runCompanion(["setup", "--json"], {
    env: {
      MCODE_PROVIDER_LIST_FIXTURE: path.join(FIXTURES_DIR, "provider-list-oauth-only.json")
    }
  });
  assert.equal(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "ready (login unverified)");
  assert.equal(parsed.activeProviders[0].providerId, "minimax_oauth");
  assert.equal(parsed.activeProviders[0].state, "unverified (login not checked)");
  assert.ok(parsed.nextStep.includes("! mcode login"));
});

test("setup reports ready and all active providers when both key and OAuth are active", () => {
  const res = runCompanion(["setup"], {
    env: {
      MCODE_PROVIDER_LIST_FIXTURE: path.join(FIXTURES_DIR, "provider-list.json")
    }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Verdict: ready"));
  assert.ok(res.stdout.includes("minimax_oauth (unverified (login not checked))"));
  assert.ok(res.stdout.includes("custom_provider:magpie (verified)"));

  const resJson = runCompanion(["setup", "--json"], {
    env: {
      MCODE_PROVIDER_LIST_FIXTURE: path.join(FIXTURES_DIR, "provider-list.json")
    }
  });
  assert.equal(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "ready");
  assert.equal(parsed.activeProviders.length, 2);
  const oauth = parsed.activeProviders.find((p) => p.providerId === "minimax_oauth");
  const magpie = parsed.activeProviders.find((p) => p.providerId === "custom_provider:magpie");
  assert.equal(oauth.state, "unverified (login not checked)");
  assert.equal(magpie.state, "verified");
});

test("setup reports not-ready when no provider is active", () => {
  const res = runCompanion(["setup"], {
    env: {
      MCODE_PROVIDER_LIST_FIXTURE: path.join(FIXTURES_DIR, "provider-list-none-active.json")
    }
  });

  assert.notEqual(res.status, 0);
  assert.ok(res.stdout.includes("Verdict: not-ready"));
  assert.ok(res.stdout.includes("! mcode login"));

  const resJson = runCompanion(["setup", "--json"], {
    env: {
      MCODE_PROVIDER_LIST_FIXTURE: path.join(FIXTURES_DIR, "provider-list-none-active.json")
    }
  });
  assert.notEqual(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "not-ready");
  assert.equal(parsed.nextStep, "! mcode login");
});

test("missing mcode on PATH prints install command without citation path", () => {
  const resText = runCompanion(["setup"], { noMcodeOnPath: true });

  assert.notEqual(resText.status, 0);
  assert.ok(resText.stdout.includes("Verdict: not-ready"));
  assert.ok(resText.stdout.includes("npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3 --registry=https://registry.npmjs.org/"));
  assert.ok(!resText.stdout.includes(".minimax-code/releases"));
  assert.ok(!resText.stdout.includes("README.md"));

  const resJson = runCompanion(["setup", "--json"], { noMcodeOnPath: true });
  assert.notEqual(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "not-ready");
  assert.equal(parsed.mcodeVersion, null);
  assert.equal(parsed.checks.mcode.ok, false);
  assert.equal(parsed.nextStep, "npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3 --registry=https://registry.npmjs.org/");
});

test("provider check never leaks maskedApiKey or baseUrl into output", () => {
  const tempDir = makeTempDir("mcode-secret-fixture-");
  const secretFixtureFile = path.join(tempDir, "provider-secrets.json");
  const secretData = JSON.stringify({
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
  }, null, 2);
  fs.writeFileSync(secretFixtureFile, secretData, "utf8");

  const resText = runCompanion(["setup"], {
    env: { MCODE_PROVIDER_LIST_FIXTURE: secretFixtureFile }
  });
  assert.equal(resText.status, 0);
  assert.ok(!resText.stdout.includes("sk-SECRET-MASKED-KEY-XYZ"));
  assert.ok(!resText.stdout.includes("secret-base-url"));
  assert.ok(!resText.stderr.includes("sk-SECRET-MASKED-KEY-XYZ"));
  assert.ok(!resText.stderr.includes("secret-base-url"));

  const resJson = runCompanion(["setup", "--json"], {
    env: { MCODE_PROVIDER_LIST_FIXTURE: secretFixtureFile }
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

test("setup verifies against real mcode on this machine", () => {
  const res = runCompanion(["setup"], { useRealMcode: true });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Verdict: ready"));
  assert.ok(res.stdout.includes("mcode version: 0.6.12"));
  assert.ok(res.stdout.includes("custom_provider:magpie (verified)"));
  assert.ok(res.stdout.includes("minimax_oauth (unverified (login not checked))"));

  const resJson = runCompanion(["setup", "--json"], { useRealMcode: true });
  assert.equal(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(parsed.verdict, "ready");
  assert.equal(parsed.mcodeVersion, "0.6.12");
  assert.ok(parsed.activeProviders.some((p) => p.providerId === "custom_provider:magpie" && p.state === "verified"));
  assert.ok(parsed.activeProviders.some((p) => p.providerId === "minimax_oauth" && p.state === "unverified (login not checked)"));
});
