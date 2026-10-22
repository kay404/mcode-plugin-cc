import { FAILURE_REASONS } from "./failure-reasons.mjs";

export function renderDelegationResult(job) {
  let prefix = "";
  if (job.readOnlyViolation?.changedPaths?.length) {
    const fileList = job.readOnlyViolation.changedPaths.map((p) => `  - ${p}`).join("\n");
    prefix = `Read-only violation: files were modified during a read-only delegation:\n${fileList}\n\n`;
  } else if (job.readOnly && job.readOnlyGuard && !job.readOnlyGuard.checked) {
    prefix = "Read-only check could not run: not a git repository.\n\n";
  }

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
  const payload = {
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
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };

  if (job.readOnly !== undefined) {
    payload.readOnly = job.readOnly;
  }
  if (job.readOnlyViolation !== undefined) {
    payload.readOnlyViolation = job.readOnlyViolation;
  }
  if (job.readOnlyGuard !== undefined) {
    payload.readOnlyGuard = job.readOnlyGuard;
  }

  return payload;
}
