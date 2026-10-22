---
description: Show mcode Jobs in this Claude session or inspect a single Job
argument-hint: "[job-id] [--all] [--json]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" status "$ARGUMENTS"`

Present the companion output above verbatim and in full, without summarising or adding commentary.
