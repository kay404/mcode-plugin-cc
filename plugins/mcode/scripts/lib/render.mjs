import { FAILURE_REASONS } from "./failure-reasons.mjs";
import { GUARD_REASONS } from "./workspace-guard.mjs";

function renderReadOnlyPrefix(guard) {
  if (!guard) return "";

  if (!guard.checked) {
    const msg = GUARD_REASONS[guard.reason] ?? "Read-only check could not run.";
    return `${msg}\n\n`;
  }

  const items = [];
  if (guard.headMoved) {
    items.push(`HEAD moved: ${guard.headMoved.from} → ${guard.headMoved.to}`);
  }
  if (guard.stashChanged) {
    items.push("stash changed");
  }
  for (const p of guard.changedPaths ?? []) {
    items.push(p);
  }

  if (items.length > 0) {
    const list = items.map((item) => `  - ${item}`).join("\n");
    return `Read-only violation: files were modified during a read-only delegation:\n${list}\n\n`;
  }

  return "";
}

export function renderDelegationResult(job) {
  const prefix = renderReadOnlyPrefix(job.readOnlyGuard);
  const sessionId = job.mcodeSessionId;
  const sessionFooter = sessionId
    ? `\n\n---\nmcode session: ${sessionId}\nTo open this session in the mcode TUI: mcode --session ${sessionId}`
    : "";

  if (job.status === "completed") {
    const rawOutput = (job.output ?? "").trim();
    return `${prefix}${rawOutput}${sessionFooter}\n`;
  }

  if (job.status === "cancelled") {
    return `${prefix}mcode delegation was cancelled.${sessionFooter}\n`;
  }

  const reasonConfig = FAILURE_REASONS[job.reason] ?? FAILURE_REASONS.error;

  if (job.reason === "needs-interaction") {
    const command = sessionId ? `mcode --session ${sessionId}` : "mcode";
    return prefix + [
      reasonConfig.heading,
      "",
      "To continue this session interactively, run:",
      `  ${command}`,
      sessionFooter ? sessionFooter.trimStart() : ""
    ].filter(Boolean).join("\n") + "\n";
  }

  const err = job.error?.message || job.stderr || reasonConfig.defaultMessage;
  return `${prefix}${reasonConfig.heading}\n\n${err}${sessionFooter}\n`;
}

export function buildJobJsonPayload(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    reason: job.reason ?? null,
    prompt: job.prompt,
    sessionId: job.sessionId ?? null,
    mcodeSessionId: job.mcodeSessionId ?? null,
    output: job.output ?? null,
    error: job.error ?? null,
    usage: job.usage ?? null,
    readOnly: job.readOnly,
    readOnlyGuard: job.readOnlyGuard ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
