import { spawn } from "node:child_process";
import process from "node:process";

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
    session
  } = options;

  if (permission === "off") {
    throw new Error("Permission level 'off' is disabled in the mcode plugin for safety.");
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

export function parseProgressEvent(event) {
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
      const toolName = item.toolCall?.name ?? "unknown";
      return `Running tool: ${toolName}...`;
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
      const toolName = item.toolCall?.name ?? "unknown";
      return `Finished tool: ${toolName}`;
    }
  }

  return null;
}

function isNeedsInteraction(error, stderr = "") {
  if (error?.code === "INTERACTION_NOT_AVAILABLE") {
    return true;
  }
  const msg = `${error?.message ?? ""} ${stderr}`.toLowerCase();
  if (msg.includes("interaction_not_available") || msg.includes("interaction not available")) {
    return true;
  }
  if (msg.includes("pending") && (msg.includes("permission") || msg.includes("questionnaire") || msg.includes("interaction"))) {
    return true;
  }
  return false;
}

export function mapMcodeResultToOutcome(execResult, stderr = "") {
  if (!execResult) {
    const interaction = isNeedsInteraction(null, stderr);
    return {
      status: "failed",
      reason: interaction ? "needs-interaction" : "error",
      output: null,
      error: { message: stderr.trim() || "mcode process exited unexpectedly without completion result" },
      mcodeSessionId: null
    };
  }

  const { status, output, error, sessionId, usage } = execResult;

  if (status === "succeeded") {
    return {
      status: "completed",
      reason: null,
      output: output ?? "",
      error: null,
      mcodeSessionId: sessionId ?? null,
      usage: usage ?? null
    };
  }

  if (status === "cancelled") {
    return {
      status: "cancelled",
      reason: null,
      output: output ?? "",
      error: error ?? null,
      mcodeSessionId: sessionId ?? null,
      usage: usage ?? null
    };
  }

  if (status === "timeout") {
    return {
      status: "failed",
      reason: "timeout",
      output: output ?? null,
      error: error ?? { message: "mcode execution timed out" },
      mcodeSessionId: sessionId ?? null,
      usage: usage ?? null
    };
  }

  if (status === "limit_exceeded") {
    return {
      status: "failed",
      reason: "limit_exceeded",
      output: output ?? null,
      error: error ?? { message: "mcode execution exceeded step limit" },
      mcodeSessionId: sessionId ?? null,
      usage: usage ?? null
    };
  }

  if (isNeedsInteraction(error, stderr)) {
    return {
      status: "failed",
      reason: "needs-interaction",
      output: output ?? null,
      error: error ?? { message: "Interactive input or permission required in TUI" },
      mcodeSessionId: sessionId ?? null,
      usage: usage ?? null
    };
  }

  return {
    status: "failed",
    reason: "error",
    output: output ?? null,
    error: error ?? { message: stderr.trim() || "mcode execution failed" },
    mcodeSessionId: sessionId ?? null,
    usage: usage ?? null
  };
}

export async function runMcode(options) {
  const argv = buildMcodeArgv(options);
  const onProgress = options.onProgress ?? (() => {});

  return new Promise((resolve, reject) => {
    let capturedSessionId = options.session ?? null;
    let execCompletedResult = null;
    let stderr = "";
    let stdoutBuffer = "";

    const child = spawn("mcode", argv, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    if (options.onSpawn) {
      options.onSpawn(child);
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
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (event.schemaVersion !== 1) {
          child.kill();
          const err = new Error(`Unsupported mcode output version: ${event.schemaVersion}`);
          err.reason = "unsupported-output-version";
          return reject(err);
        }

        if (event.sessionId) {
          capturedSessionId = event.sessionId;
        }

        if (event.type === "exec.completed") {
          execCompletedResult = event.result ?? null;
          if (execCompletedResult?.sessionId) {
            capturedSessionId = execCompletedResult.sessionId;
          }
        }

        const progressMsg = parseProgressEvent(event);
        if (progressMsg) {
          onProgress(progressMsg);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        const notFoundErr = new Error("mcode executable was not found on PATH. Run /mcode:setup to check requirements and install instructions.");
        notFoundErr.reason = "mcode-not-found";
        return reject(notFoundErr);
      }
      reject(err);
    });

    child.on("close", (exitCode) => {
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim());
          if (event.schemaVersion !== 1) {
            const err = new Error(`Unsupported mcode output version: ${event.schemaVersion}`);
            err.reason = "unsupported-output-version";
            return reject(err);
          }
          if (event.sessionId) {
            capturedSessionId = event.sessionId;
          }
          if (event.type === "exec.completed") {
            execCompletedResult = event.result ?? null;
            if (execCompletedResult?.sessionId) {
              capturedSessionId = execCompletedResult.sessionId;
            }
          }
        } catch {
          // Ignore incomplete buffer parse at close
        }
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
