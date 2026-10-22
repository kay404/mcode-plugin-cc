import { spawnSync } from "node:child_process";
import process from "node:process";

export const REQUIRED_NODE_RANGE = ">=22.19 <23 || >=24 <27";
const OFFICIAL_INSTALL_CMD = "npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3 --registry=https://registry.npmjs.org/";

export function isNodeVersionSupported(versionStr = process.versions.node) {
  const parts = versionStr.split(".").map((s) => parseInt(s, 10));
  const major = parts[0] ?? -1;
  const minor = parts[1] ?? 0;
  return (major === 22 && minor >= 19) || (major >= 24 && major < 27);
}

export function checkNodeVersion(versionStr = process.versions.node) {
  const ok = isNodeVersionSupported(versionStr);
  return {
    ok,
    version: versionStr,
    required: REQUIRED_NODE_RANGE
  };
}

export function checkMcodeVersion() {
  const res = spawnSync("mcode", ["--version"], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    return { ok: false, version: null };
  }
  const version = (res.stdout ?? "").trim();
  return { ok: Boolean(version), version: version || null };
}

export function checkHeadlessExec() {
  const res = spawnSync("mcode", ["exec", "--help"], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    return { ok: false };
  }
  const stdout = res.stdout ?? "";
  return { ok: stdout.includes("mcode exec") };
}

export function checkProvider() {
  const res = spawnSync("mcode", ["provider", "list", "--json"], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    return { ok: false, verdict: "not-ready", nextStep: "! mcode login", activeProviders: [] };
  }

  let raw;
  try {
    raw = JSON.parse(res.stdout ?? "");
  } catch {
    return { ok: false, verdict: "not-ready", nextStep: "! mcode login", activeProviders: [] };
  }

  const rawProviders = Array.isArray(raw?.providers) ? raw.providers : [];

  // Retain ONLY allowed fields to prevent any secret exposure
  const providers = rawProviders.map((p) => ({
    providerId: p.providerId,
    kind: p.kind,
    active: Boolean(p.active),
    enabled: p.enabled !== false,
    hasApiKey: Boolean(p.hasApiKey)
  }));

  const activeProviders = [];
  for (const p of providers) {
    if (p.active && p.enabled) {
      let state;
      if (p.hasApiKey) {
        state = "verified";
      } else if (p.kind === "minimax-oauth") {
        state = "unverified: login not checked";
      } else {
        state = "unverified: no API key";
      }
      activeProviders.push({
        providerId: p.providerId,
        kind: p.kind,
        state
      });
    }
  }

  const hasVerified = activeProviders.some((p) => p.state === "verified");
  const hasUnverifiedOauth = activeProviders.some((p) => p.state === "unverified: login not checked");

  let verdict;
  let nextStep = null;

  if (hasVerified) {
    verdict = "ready";
  } else if (hasUnverifiedOauth) {
    verdict = "ready (login unverified)";
    nextStep = "If delegations fail on auth, run: ! mcode login";
  } else {
    verdict = "not-ready";
    nextStep = "! mcode login";
  }

  return {
    ok: hasVerified || hasUnverifiedOauth,
    verdict,
    nextStep,
    activeProviders
  };
}

export function runSetupChecks() {
  const nodeCheck = checkNodeVersion();
  const mcodeCheck = checkMcodeVersion();
  const headlessCheck = mcodeCheck.ok ? checkHeadlessExec() : { ok: false };
  const providerCheck = mcodeCheck.ok
    ? checkProvider()
    : { ok: false, verdict: "not-ready", nextStep: "! mcode login", activeProviders: [] };

  let verdict = "ready";
  let nextStep = null;

  if (!nodeCheck.ok) {
    verdict = "not-ready";
    nextStep = `Node.js in range ${REQUIRED_NODE_RANGE} is required (current: ${nodeCheck.version}).`;
  } else if (!mcodeCheck.ok) {
    verdict = "not-ready";
    nextStep = OFFICIAL_INSTALL_CMD;
  } else if (!headlessCheck.ok) {
    verdict = "not-ready";
    nextStep = `mcode headless exec is unavailable. Reinstall or update mcode:\n  ${OFFICIAL_INSTALL_CMD}`;
  } else if (!providerCheck.ok) {
    verdict = "not-ready";
    nextStep = providerCheck.nextStep || "! mcode login";
  } else if (providerCheck.verdict === "ready (login unverified)") {
    verdict = "ready (login unverified)";
    nextStep = providerCheck.nextStep;
  }

  return {
    verdict,
    mcodeVersion: mcodeCheck.version,
    activeProviders: providerCheck.activeProviders,
    nextStep,
    checks: {
      node: nodeCheck,
      mcode: mcodeCheck,
      headless: headlessCheck,
      provider: {
        ok: providerCheck.ok,
        verdict: providerCheck.verdict,
        providers: providerCheck.activeProviders
      }
    }
  };
}

export function renderSetupResult(result) {
  const lines = [`Verdict: ${result.verdict}`];

  if (result.mcodeVersion) {
    lines.push(`mcode version: ${result.mcodeVersion}`);
  }

  if (result.activeProviders && result.activeProviders.length > 0) {
    lines.push("Active providers:");
    for (const p of result.activeProviders) {
      lines.push(`  - ${p.providerId} (${p.state})`);
    }
  }

  if (result.nextStep) {
    const label = result.verdict === "ready (login unverified)" ? "Hint:" : "Next step:";
    lines.push("", label);
    for (const line of result.nextStep.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  return lines.join("\n") + "\n";
}
