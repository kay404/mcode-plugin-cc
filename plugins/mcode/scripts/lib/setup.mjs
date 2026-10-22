import { spawnSync } from "node:child_process";
import process from "node:process";

const REQUIRED_NODE_RANGE = ">=22.19 <23 || >=24 <27";
const OFFICIAL_INSTALL_CMD = "npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3 --registry=https://registry.npmjs.org/";
const OFFICIAL_INSTALL_CITATION = "~/.minimax-code/releases/0.6.12/lib/node_modules/@minimax-ai/code/README.md";

export function checkNodeVersion(versionStr = process.env.MCODE_NODE_VERSION || process.versions.node) {
  const parts = versionStr.split(".").map((s) => parseInt(s, 10));
  const major = parts[0] ?? -1;
  const minor = parts[1] ?? 0;
  const ok = (major === 22 && minor >= 19) || (major >= 24 && major < 27);
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
    return { ok: false, activeProviderId: null };
  }

  let raw;
  try {
    raw = JSON.parse(res.stdout ?? "");
  } catch {
    return { ok: false, activeProviderId: null };
  }

  const minimaxModelSource = raw?.minimaxModelSource ?? null;
  const rawProviders = Array.isArray(raw?.providers) ? raw.providers : [];

  // Retain ONLY allowed fields to prevent any secret exposure
  const providers = rawProviders.map((p) => ({
    providerId: p.providerId,
    kind: p.kind,
    active: Boolean(p.active),
    enabled: p.enabled !== false,
    hasApiKey: Boolean(p.hasApiKey)
  }));

  const usable = providers.find((p) => {
    if (!p.active || !p.enabled) return false;
    if (p.kind === "minimax-oauth") {
      return minimaxModelSource === "token_plan" || p.active;
    }
    return p.hasApiKey === true;
  });

  return {
    ok: Boolean(usable),
    activeProviderId: usable ? usable.providerId : null
  };
}

export function runSetupChecks() {
  const nodeCheck = checkNodeVersion();
  const mcodeCheck = checkMcodeVersion();
  const headlessCheck = mcodeCheck.ok ? checkHeadlessExec() : { ok: false };
  const providerCheck = mcodeCheck.ok ? checkProvider() : { ok: false, activeProviderId: null };

  const ready = nodeCheck.ok && mcodeCheck.ok && headlessCheck.ok && providerCheck.ok;
  const verdict = ready ? "ready" : "not-ready";

  let nextStep = null;
  if (!ready) {
    if (!nodeCheck.ok) {
      nextStep = `Node.js in range ${REQUIRED_NODE_RANGE} is required (current: ${nodeCheck.version}).`;
    } else if (!mcodeCheck.ok) {
      nextStep = `Install mcode:\n  ${OFFICIAL_INSTALL_CMD}\n(Official install command cited from ${OFFICIAL_INSTALL_CITATION})`;
    } else if (!headlessCheck.ok) {
      nextStep = `mcode headless exec is unavailable. Reinstall or update mcode:\n  ${OFFICIAL_INSTALL_CMD}\n(Official install command cited from ${OFFICIAL_INSTALL_CITATION})`;
    } else if (!providerCheck.ok) {
      nextStep = "! mcode login";
    }
  }

  return {
    verdict,
    mcodeVersion: mcodeCheck.version,
    activeProviderId: providerCheck.activeProviderId,
    nextStep,
    checks: {
      node: nodeCheck,
      mcode: mcodeCheck,
      headless: headlessCheck,
      provider: providerCheck
    }
  };
}

export function renderSetupResult(result) {
  if (result.verdict === "ready") {
    return [
      "Verdict: ready",
      `mcode version: ${result.mcodeVersion}`,
      `Active provider: ${result.activeProviderId}`
    ].join("\n") + "\n";
  }

  const lines = ["Verdict: not-ready", "", "Next step:"];
  for (const line of (result.nextStep ?? "").split("\n")) {
    lines.push(`  ${line}`);
  }
  return lines.join("\n") + "\n";
}
