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

  if (job.status === "failed") {
    if (job.reason === "mcode-not-found") {
      return [
        "mcode was not found on PATH.",
        "",
        "Please install mcode or run /mcode:setup to check requirements and installation instructions.",
        ""
      ].join("\n");
    }

    if (job.reason === "unsupported-output-version") {
      const err = job.error?.message || "The mcode version emitted an unrecognized output stream schema.";
      return [
        "Unsupported mcode output version.",
        "",
        err,
        ""
      ].join("\n");
    }

    if (job.reason === "needs-interaction") {
      const command = sessionId ? `mcode --session ${sessionId}` : "mcode";
      return [
        "mcode requires interaction that is not available in headless mode.",
        "",
        "To continue this session interactively, run:",
        `  ${command}`,
        ""
      ].join("\n");
    }

    if (job.reason === "timeout") {
      const err = job.error?.message || "Operation timed out.";
      return `mcode delegation timed out.\n\n${err}${sessionFooter}\n`;
    }

    if (job.reason === "limit_exceeded") {
      const err = job.error?.message || "Step limit exceeded.";
      return `mcode delegation exceeded step limit.\n\n${err}${sessionFooter}\n`;
    }

    const err = job.error?.message || job.stderr || "Unknown failure.";
    return `mcode delegation failed.\n\n${err}${sessionFooter}\n`;
  }

  return `Job ${job.id} (${job.status})${sessionFooter}\n`;
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
