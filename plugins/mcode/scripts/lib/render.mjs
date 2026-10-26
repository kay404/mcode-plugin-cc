import { FAILURE_REASONS, JOB_KIND_NOUNS, getFailureHeading } from "./failure-reasons.mjs";
import { GUARD_REASONS } from "./workspace-guard.mjs";

function renderReadOnlyPrefix(guard, noun = "delegation") {
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
    return `Read-only violation: files were modified during a read-only ${noun}:\n${list}\n\n`;
  }

  return "";
}

function renderOutput(output) {
  if (typeof output === "string") {
    return output.trim();
  }
  if (!output || typeof output !== "object") {
    return "";
  }

  const hasVerdict = Boolean(output.verdict);
  const hasSummary = Boolean(output.summary);
  const hasFindings = Array.isArray(output.findings) && output.findings.length > 0;

  if (!hasVerdict && !hasSummary && !hasFindings) {
    return JSON.stringify(output, null, 2);
  }

  const lines = [];
  if (hasVerdict) {
    lines.push(`Verdict: ${output.verdict}`);
  }
  if (hasSummary) {
    lines.push(output.summary.trim());
  }
  if (hasFindings) {
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

const SEVERITY_RANKS = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

function renderAdversarialReviewOutput(output) {
  const lines = [];

  if (output.verdict) {
    lines.push(`Verdict: ${output.verdict}`);
  }

  if (output.summary) {
    if (lines.length > 0) lines.push("");
    lines.push(output.summary.trim());
  }

  if (Array.isArray(output.findings) && output.findings.length > 0) {
    const sorted = [...output.findings].sort(
      (a, b) => SEVERITY_RANKS[a.severity] - SEVERITY_RANKS[b.severity]
    );

    for (const f of sorted) {
      lines.push("");
      lines.push(`[${f.severity}] ${f.title}`);
      lines.push(`${f.file}:${f.line_start}-${f.line_end}`);
      lines.push(`Confidence: ${f.confidence}`);
      lines.push(f.body.trim());
      lines.push(`Recommendation: ${f.recommendation.trim()}`);
    }
  }

  if (Array.isArray(output.next_steps) && output.next_steps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of output.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n").trim();
}

const MAX_LISTED_PATHS = 20;

// The model mcode reports wins over the one requested; effort is never reported, so only a requested one is known.
export function describeRunSettings(job) {
  const model = job.mcodeModel ?? (job.model ? `${job.model} (requested)` : "mcode default");
  const permission = `${job.permission ?? "smart"}${job.readOnly ? ", read-only" : ""}`;
  return `model ${model}, effort ${job.effort ?? "mcode default"}, permission ${permission}`;
}

export function shortTitle(title) {
  const firstLine = String(title ?? "").trim().split("\n")[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function renderRunNotes(job) {
  const sections = [];
  if (job.blockedToolCalls?.length) {
    sections.push([
      "These tool calls failed because a headless mcode run cannot ask for approval (--full allows those that smart permission blocked):",
      ...job.blockedToolCalls.map((call) => `  - ${call}`)
    ].join("\n"));
  }
  const paths = job.newUntrackedPaths ?? [];
  if (paths.length) {
    const listed = paths.slice(0, MAX_LISTED_PATHS).map((p) => `  - ${p}`);
    if (paths.length > MAX_LISTED_PATHS) listed.push(`  - ... and ${paths.length - MAX_LISTED_PATHS} more`);
    sections.push(["New untracked files left in the working tree (gitignored ones included):", ...listed].join("\n"));
  }
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

const KIND_OUTPUT_RENDERERS = {
  "adversarial-review": renderAdversarialReviewOutput,
  "review": renderOutput,
  "delegate": renderOutput
};

export function renderDelegationResult(job) {
  const noun = JOB_KIND_NOUNS[job.kind] ?? "delegation";
  const prefix = renderReadOnlyPrefix(job.readOnlyGuard, noun);
  const sessionId = job.mcodeSessionId;
  const sessionLines = sessionId
    ? `\nmcode session: ${sessionId}\nTo open this session in the mcode TUI: mcode --session ${sessionId}`
    : "";
  const footer = `${renderRunNotes(job)}\n\n---${sessionLines}\nmcode run: ${describeRunSettings(job)}`;

  if (job.status === "completed") {
    const render = KIND_OUTPUT_RENDERERS[job.kind] ?? renderOutput;
    const rawOutput = render(job.output);
    return `${prefix}${rawOutput}${footer}\n`;
  }

  if (job.status === "cancelled") {
    return `${prefix}mcode ${noun} was cancelled.${footer}\n`;
  }

  const heading = getFailureHeading(job.reason, noun);

  if (job.reason === "needs-interaction") {
    const command = sessionId ? `mcode --session ${sessionId}` : "mcode";
    return prefix + [
      heading,
      "",
      "To continue this session interactively, run:",
      `  ${command}`,
      footer ? footer.trimStart() : ""
    ].filter(Boolean).join("\n") + "\n";
  }

  const reasonConfig = FAILURE_REASONS[job.reason] ?? FAILURE_REASONS.error;
  const err = job.error?.message || job.stderr || reasonConfig.defaultMessage;
  return `${prefix}${heading}\n\n${err}${footer}\n`;
}

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
    `Title:          ${shortTitle(job.title) || "-"}`,
    `Run settings:   ${describeRunSettings(job)}`,
    `Claude session: ${job.sessionId || "-"}`,
    `mcode session:  ${job.mcodeSessionId ? job.mcodeSessionId : "-"}`
  ];

  if (job.blockedToolCalls?.length) {
    lines.push("Blocked by smart permission:");
    for (const call of job.blockedToolCalls) {
      lines.push(`  - ${call}`);
    }
  }

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
    model: job.model ?? null,
    effort: job.effort ?? null,
    permission: job.permission ?? null,
    mcodeModel: job.mcodeModel ?? null,
    blockedToolCalls: job.blockedToolCalls ?? [],
    newUntrackedPaths: job.newUntrackedPaths ?? null,
    readOnly: job.readOnly,
    readOnlyGuard: job.readOnlyGuard ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
