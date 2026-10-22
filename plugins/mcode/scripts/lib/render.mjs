import { FAILURE_REASONS } from "./failure-reasons.mjs";

export function renderDelegationResult(job) {
  const sessionId = job.mcodeSessionId;
  const sessionFooter = sessionId
    ? `\n\n---\nmcode session: ${sessionId}\nTo open this session in the mcode TUI: mcode --session ${sessionId}`
    : "";

  if (job.status === "completed") {
    const rawOutput = (job.output ?? "").trim();
    return `${rawOutput}${sessionFooter}\n`;
  }

  if (job.status === "cancelled") {
    return `mcode delegation was cancelled.${sessionFooter}\n`;
  }

  const reasonConfig = FAILURE_REASONS[job.reason] ?? FAILURE_REASONS.error;

  if (job.reason === "needs-interaction") {
    const command = sessionId ? `mcode --session ${sessionId}` : "mcode";
    return [
      reasonConfig.heading,
      "",
      "To continue this session interactively, run:",
      `  ${command}`,
      sessionFooter ? sessionFooter.trimStart() : ""
    ].filter(Boolean).join("\n") + "\n";
  }

  const err = job.error?.message || job.stderr || reasonConfig.defaultMessage;
  return `${reasonConfig.heading}\n\n${err}${sessionFooter}\n`;
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
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
