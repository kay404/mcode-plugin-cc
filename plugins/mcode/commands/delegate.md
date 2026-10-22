---
description: Delegate investigation, diagnosis, or implementation to MiniMax's mcode coding agent
argument-hint: "[--read-only] [--full] [--model <provider/model>] [--effort <low|medium|high|xhigh|max>] [task description]"
allowed-tools: Bash(node:*), Agent
---

Invoke the `mcode:mcode-delegate` subagent via the `Agent` tool (`subagent_type: "mcode:mcode-delegate"`), forwarding the raw user request as the prompt.
`mcode:mcode-delegate` is a subagent, not a skill — do not call `Skill(mcode:mcode-delegate)`.
The command runs inline so the `Agent` tool stays in scope.
The final user-visible response must be mcode's output verbatim.

Raw user request:
$ARGUMENTS

Operating rules:

- The subagent is a thin forwarder only. It uses exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" delegate ...` and returns that command's stdout as-is.
- Return the mcode companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll status, or do independent implementation.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave model unset unless the user explicitly asks for one.
- Pass `--full` only when the user explicitly requests full permissions; default to write intent with smart permission.
- If the user did not supply a request, ask what mcode should investigate or implement.
