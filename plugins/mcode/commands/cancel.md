---
description: Cancel a running or queued mcode Job in this Claude session
argument-hint: "[job-id] [--json]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" cancel "$ARGUMENTS"`

Present the companion output above verbatim and in full, without summarising or adding commentary.
