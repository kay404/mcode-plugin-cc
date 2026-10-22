import { FAILURE_REASONS } from "./failure-reasons.mjs";
import { GUARD_REASONS } from "./workspace-guard.mjs";

function renderReadOnlyPrefix(guard, jobKind) {
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
    const noun = jobKind === "review" ? "review" : "delegation";
    return `Read-only violation: files were modified during a read-only ${noun}:\n${list}\n\n`;
  }

  return "";
}

export function renderReviewOutput(output) {
  if (typeof output === "string") {
    return output.trim();
  }
  if (!output || typeof output !== "object") {
    return "";
  }
  const lines = [];
  if (output.summary) {
    lines.push(output.summary.trim());
  }
  if (Array.isArray(output.findings) && output.findings.length > 0) {
    for (const f of output.findings) {
      const parts = [];
      const priority = f.priority ? `[${f.priority}] ` : "";
      const title = f.title || "";
      if (priority || title) {
        parts.push(`${priority}${title}`.trim());
      }
      const locParts = [];
      if (f.path) {
        let loc = f.path;
        if (f.startLine !== undefined && f.startLine !== null) {
          loc += `:${f.startLine}`;
          if (f.endLine !== undefined && f.endLine !== null && f.endLine !== f.startLine) {
            loc += `-${f.endLine}`;
          }
        }
        locParts.push(loc);
      }
      if (f.side) {
        locParts.push(`(${f.side})`);
      }
      if (locParts.length > 0) {
        parts.push(locParts.join(" "));
      }
      if (f.content) {
        parts.push(f.content.trim());
      }
      if (parts.length > 0) {
        lines.push("");
        lines.push(parts.join("\n"));
      }
    }
  }
  return lines.join("\n").trim();
}

export function renderDelegationResult(job) {
  const prefix = renderReadOnlyPrefix(job.readOnlyGuard, job.kind);
  const sessionId = job.mcodeSessionId;
  const sessionFooter = sessionId
    ? `\n\n---\nmcode session: ${sessionId}\nTo open this session in the mcode TUI: mcode --session ${sessionId}`
    : "";

  if (job.status === "completed") {
    const rawOutput = job.kind === "review"
      ? renderReviewOutput(job.output)
      : (typeof job.output === "string" ? job.output.trim() : renderReviewOutput(job.output));
    return `${prefix}${rawOutput}${sessionFooter}\n`;
  }

  if (job.status === "cancelled") {
    const noun = job.kind === "review" ? "mcode review" : "mcode delegation";
    return `${prefix}${noun} was cancelled.${sessionFooter}\n`;
  }

  const reasonConfig = FAILURE_REASONS[job.reason] ?? FAILURE_REASONS.error;
  const heading = job.kind === "review"
    ? (job.reason === "error" ? "mcode review failed." : job.reason === "timeout" ? "mcode review timed out." : job.reason === "limit-exceeded" ? "mcode review exceeded step limit." : reasonConfig.heading)
    : reasonConfig.heading;

  if (job.reason === "needs-interaction") {
    const command = sessionId ? `mcode --session ${sessionId}` : "mcode";
    return prefix + [
      heading,
      "",
      "To continue this session interactively, run:",
      `  ${command}`,
      sessionFooter ? sessionFooter.trimStart() : ""
    ].filter(Boolean).join("\n") + "\n";
  }

  const err = job.error?.message || job.stderr || reasonConfig.defaultMessage;
  return `${prefix}${heading}\n\n${err}${sessionFooter}\n`;
}

export const renderJobResult = renderDelegationResult;

export function formatAge(dateStr, now = Date.now()) {
  const ts = new Date(dateStr).getTime();
  if (Number.isNaN(ts)) {
    return "-";
  }
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 60) {
    return `${diffSec}s`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

export function renderStatusTable(jobs) {
  if (jobs.length === 0) {
    return "No Jobs found.\n";
  }

  const headers = ["ID", "KIND", "STATE", "AGE", "PROGRESS"];
  const rows = jobs.map((job) => [
    job.id,
    job.kind,
    job.reason ? `${job.status} (${job.reason})` : job.status,
    formatAge(job.createdAt),
    job.progressPreview || "-"
  ]);

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || "").length))
  );

  const formatRow = (cols) =>
    cols.map((col, i) => (col || "").padEnd(colWidths[i])).join("  ").trimEnd();

  const lines = [
    formatRow(headers),
    formatRow(colWidths.map((w) => "-".repeat(w))),
    ...rows.map((row) => formatRow(row))
  ];

  return lines.join("\n") + "\n";
}

export function renderJobDetail(job, progressLines = []) {
  const lines = [
    `Job ID:         ${job.id}`,
    `Kind:           ${job.kind}`,
    `State:          ${job.status}${job.reason ? ` (${job.reason})` : ""}`,
    `Title:          ${job.title || "-"}`,
    `Claude session: ${job.sessionId || "-"}`,
    `mcode session:  ${job.mcodeSessionId ? job.mcodeSessionId : "-"}`
  ];

  if (job.processId) {
    lines.push(`Process ID:     ${job.processId}`);
  }

  lines.push(`Created:        ${job.createdAt}`);
  lines.push(`Updated:        ${job.updatedAt}`);

  lines.push("");
  lines.push("Recent progress:");
  if (progressLines.length === 0) {
    lines.push("  (no progress recorded)");
  } else {
    for (const line of progressLines) {
      lines.push(`  ${line}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function buildJobJsonPayload(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    reason: job.reason ?? null,
    prompt: job.prompt,
    cwd: job.cwd ?? null,
    sessionId: job.sessionId ?? null,
    mcodeSessionId: job.mcodeSessionId ?? null,
    processId: job.processId ?? null,
    output: job.output ?? null,
    renderedOutput: job.renderedOutput ?? null,
    error: job.error ?? null,
    usage: job.usage ?? null,
    readOnly: job.readOnly,
    readOnlyGuard: job.readOnlyGuard ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
