---
name: mcode-cli-runtime
description: Internal helper contract for calling the mcode-companion runtime from Claude Code
user-invocable: false
---

# mcode CLI Runtime

Use this skill inside the `mcode:mcode-delegate` agent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" delegate [options] "<prompt>"`

Execution rules:
- The delegate agent is a thin forwarder, not an orchestrator. Its only job is to invoke `delegate` once and return that stdout unchanged.
- Prefer the companion helper over direct `mcode` CLI strings or manual subprocess execution.
- Use `delegate` for diagnosis, research, and implementation requests.
- Default to write intent with smart permission. Add `--full` only when the user explicitly requests full permission. Add `--read-only` when the user asks for read-only behavior or research without modifications.
- Leave `--model` and `--effort` unset unless explicitly requested by the user.

Prompt composition guidance:
- When structuring an open-ended delegation prompt, format with clear sections:
  - `<task>`: Concrete goal and scope.
  - `<constraints>`: What not to touch, dependencies, style rules.
  - `<definition_of_done>`: Observable conditions that define completion.
  - `<verification>`: How mcode should test or verify its changes.
- For follow-up turns on an existing session, send only the delta instruction rather than repeating prior context.

Safety and output rules:
- Return the stdout of the `delegate` command exactly as-is.
- Do not inspect files, run tests, or attempt Claude-side fixes.
- If the companion command fails, report the error verbatim and do not substitute a Claude-generated implementation.
