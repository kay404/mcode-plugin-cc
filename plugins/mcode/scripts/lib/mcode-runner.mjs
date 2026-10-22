import { spawn } from "node:child_process";
import process from "node:process";
import { FAILURE_REASONS } from "./failure-reasons.mjs";

export function wrapReadOnlyPrompt(task) {
  return [
    "IMPORTANT: This is a read-only investigation. You MUST NOT create, modify, or delete any file, nor execute commands that mutate the workspace or system. Only investigate and report your findings.",
    "",
    task
  ].join("\n");
}

export function buildMcodeArgv(options) {
  const {
    cwd = process.cwd(),
    permission = "smart",
    model,
    effort,
    session,
    command
  } = options;

  if (permission === "off") {
    throw new Error("Permission level 'off' is disabled in the mcode plugin for safety.");
  }

  if (command === "review") {
    return [
      "exec",
      "review",
      "--cwd",
      cwd,
      "--permission",
      permission,
      "--output-format",
      "stream-json"
    ];
  }

  const argv = [
    "exec",
    "--cwd",
    cwd,
    "--permission",
    permission,
    "--output-format",
    "stream-json",
    "--input",
    "-"
  ];

  if (model) {
    argv.push("--model", model);
  }

  if (effort) {
    argv.push("--effort", effort);
  }

  if (session) {
    argv.push("--session", session);
  }

  return argv;
}

export function describeProgress(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.type === "turn.started") {
    return "Starting turn...";
  }

  if (event.type === "item.started") {
    const item = event.item;
    if (!item) return null;
    if (item.type === "tool_call") {
      return `Running tool: ${item.toolCall?.name ?? "unknown"}...`;
    }
    if (item.type === "reasoning") {
      return "Thinking...";
    }
    if (item.type === "agent_message") {
      return "Responding...";
    }
  }

  if (event.type === "item.completed") {
    const item = event.item;
    if (!item) return null;
    if (item.type === "tool_call") {
      return `Finished tool: ${item.toolCall?.name ?? "unknown"}`;
    }
  }

  return null;
}

function isNeedsInteraction(error, stderr = "") {
  if (error?.code === "INTERACTION_NOT_AVAILABLE") {
    return true;
  }
  // debt: substring heuristic; replace with mcode's exact error code once a real pending-session refusal is recorded
  const msg = `${error?.message ?? ""} ${stderr}`.toLowerCase();
  return msg.includes("interaction_not_available") ||
    msg.includes("interaction not available") ||
    (msg.includes("pending") && (msg.includes("permission") || msg.includes("questionnaire") || msg.includes("interaction")));
}

export function mapMcodeResultToOutcome(execResult, stderr = "") {
  if (!execResult) {
    const interaction = isNeedsInteraction(null, stderr);
    return {
      status: "failed",
      reason: interaction ? "needs-interaction" : "error",
      output: null,
      error: { message: stderr.trim() || FAILURE_REASONS.error.defaultMessage },
      mcodeSessionId: null,
      usage: null
    };
  }

  const { status, output, error, sessionId, usage } = execResult;
  const base = {
    status: "failed",
    reason: "error",
    output: output ?? null,
    error: error ?? null,
    mcodeSessionId: sessionId ?? null,
    usage: usage ?? null
  };

  if (status === "succeeded") {
    return { ...base, status: "completed", reason: null, output: output ?? "", error: null };
  }
  if (status === "cancelled") {
    return { ...base, status: "cancelled", reason: null, output: output ?? "" };
  }
  if (status === "timeout") {
    return { ...base, reason: "timeout", error: error ?? { message: FAILURE_REASONS.timeout.defaultMessage } };
  }
  if (status === "limit_exceeded") {
    return { ...base, reason: "limit-exceeded", error: error ?? { message: FAILURE_REASONS["limit-exceeded"].defaultMessage } };
  }
  if (isNeedsInteraction(error, stderr)) {
    return { ...base, reason: "needs-interaction", error: error ?? { message: FAILURE_REASONS["needs-interaction"].defaultMessage } };
  }
  if (error?.code && error.code.startsWith("REVIEW_")) {
    const reasonKey = error.code.toLowerCase().replace(/_/g, "-");
    return {
      ...base,
      reason: reasonKey,
      error: error ?? { message: FAILURE_REASONS[reasonKey]?.defaultMessage || FAILURE_REASONS.error.defaultMessage }
    };
  }

  return { ...base, error: error ?? { message: stderr.trim() || FAILURE_REASONS.error.defaultMessage } };
}

export async function runMcode(options) {
  const argv = buildMcodeArgv(options);
  const onProgress = options.onProgress ?? (() => {});

  return new Promise((resolve, reject) => {
    let capturedSessionId = options.session ?? null;
    let execCompletedResult = null;
    let stderr = "";
    let stdoutBuffer = "";

    function processLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (event.sessionId) {
        capturedSessionId = event.sessionId;
      }

      if (event.schemaVersion !== 1) {
        child.kill();
        const err = new Error(`Unsupported mcode output version: ${event.schemaVersion}`);
        err.reason = "unsupported-output-version";
        err.sessionId = capturedSessionId;
        return reject(err);
      }

      if (event.type === "exec.completed") {
        execCompletedResult = event.result ?? null;
        if (execCompletedResult?.sessionId) {
          capturedSessionId = execCompletedResult.sessionId;
        }
      }

      const progressMsg = describeProgress(event);
      if (progressMsg) {
        onProgress(progressMsg);
      }
    }

    const child = spawn("mcode", argv, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const forwardSignal = (sig) => {
      try {
        child.kill(sig);
      } catch {}
      const code = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129;
      process.exit(code);
    };

    const onSigTerm = () => forwardSignal("SIGTERM");
    const onSigInt = () => forwardSignal("SIGINT");
    const onSigHup = () => forwardSignal("SIGHUP");

    process.on("SIGTERM", onSigTerm);
    process.on("SIGINT", onSigInt);
    process.on("SIGHUP", onSigHup);

    function cleanupSignals() {
      process.off("SIGTERM", onSigTerm);
      process.off("SIGINT", onSigInt);
      process.off("SIGHUP", onSigHup);
    }

    if (options.prompt) {
      child.stdin.end(options.prompt, "utf8");
    } else {
      child.stdin.end();
    }

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      cleanupSignals();
      if (err.code === "ENOENT") {
        const notFoundErr = new Error(FAILURE_REASONS["mcode-not-found"].defaultMessage);
        notFoundErr.reason = "mcode-not-found";
        return reject(notFoundErr);
      }
      reject(err);
    });

    child.on("close", (exitCode) => {
      cleanupSignals();
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer.trim());
      }

      const outcome = mapMcodeResultToOutcome(execCompletedResult, stderr);
      if (!outcome.mcodeSessionId && capturedSessionId) {
        outcome.mcodeSessionId = capturedSessionId;
      }

      resolve({
        ...outcome,
        exitCode,
        stderr
      });
    });
  });
}
