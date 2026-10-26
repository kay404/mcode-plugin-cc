---
name: mcode-cli-runtime
description: Internal helper contract for calling the mcode-companion runtime from Claude Code
user-invocable: false
---

# mcode CLI Runtime

Use this skill inside the `mcode:mcode-delegate` agent.

Helpers, in order:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" delegate --background [--read-only] [--full] [--resume] [--fresh] [--model <model>] [--effort <effort>] "<prompt>"`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" status <job-id> --wait --timeout-ms 540000` (Bash `timeout` 600000; repeat while it exits with code 124, `Timed out waiting for Job`)
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" result <job-id>`

Execution rules:
- The delegate agent is a thin forwarder, not an orchestrator. It starts a background Job, waits for it, and returns the `result` stdout unchanged. When the user asked for background execution it returns the launch output instead and does not wait.
- Waiting in bounded `status --wait` calls keeps each Bash call under the tool timeout, and an interrupted wait leaves the Job running; use `/mcode:cancel` to stop it.
- Prefer the companion helper over direct `mcode` CLI strings or manual subprocess execution.
- Use `delegate` for diagnosis, research, and implementation requests.
- Add `--full` only when the user explicitly requests full permission. Add `--read-only` when the user asks for read-only behavior or research without modifications. Do not pass `--permission`.
- Add `--resume` when the user supplies `--resume` or uses continuation phrasing ("continue", "keep going", "apply the top fix", "dig deeper").
- Start a fresh session when the user supplies `--fresh`.
- Leave `--model` and `--effort` unset unless explicitly requested by the user.

Prompt composition guidance:
- When structuring an open-ended delegation prompt, format with clear sections:
  - `<task>`: Concrete goal and scope.
  - `<constraints>`: What not to touch, dependencies, style rules.
  - `<definition_of_done>`: Observable conditions that define completion.
  - `<verification>`: How mcode should test or verify its changes.
  - `<output_contract>`: Desired structure, schema, or formatting of the final response.
- For follow-up turns on an existing session, send only the delta instruction rather than repeating prior context.

Safety and output rules:
- Return the stdout of the `result` command (or of `delegate` when it fails or the user asked for background execution) exactly as-is.
- Do not inspect files, run tests, or attempt Claude-side fixes.
- If the companion command fails, report the error verbatim and do not substitute a Claude-generated implementation.
