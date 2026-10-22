---
description: Check that mcode is installed, supported, and authenticated
argument-hint: "[--json]"
allowed-tools: Bash(node:*)
---

Check environment requirements and authentication status for MiniMax Code (mcode).

Run the companion CLI setup command:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" setup $ARGUMENTS
```

Operating rules:
- Run the setup check using Bash.
- Return the command output verbatim to the user.
- Do not install anything automatically.
