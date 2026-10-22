---
description: Print the stored output of a finished mcode Job
argument-hint: "[job-id] [--all] [--json]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" result "$ARGUMENTS"`

Present the companion output above verbatim and in full, without summarising or adding commentary.
