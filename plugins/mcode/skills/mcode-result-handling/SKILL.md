---
name: mcode-result-handling
description: Internal guidance for presenting mcode helper output back to the user
user-invocable: false
---

# mcode Result Handling

When the helper returns mcode output:
- Present mcode's output verbatim to the user without summarizing, paraphrasing, or rewriting.
- Preserve all structural sections, evidence boundaries, file paths, and line numbers exactly as reported.
- Ensure the trailing mcode session id and TUI resumption command (`mcode --session <id>`) are shown so the user can interactively continue.
- For `mcode:mcode-delegate`, do not turn a failed or incomplete mcode run into a Claude-side implementation attempt. Report the failure and stop.
- If mcode failed or was never successfully invoked, do not generate a substitute answer.
- If the output indicates that interactive approval was needed (`needs-interaction`), inform the user to continue in the mcode TUI with `mcode --session <id>`.
- Read-only violations are surfaced first before any mcode output, listing changed paths, HEAD movements, or stash changes; if the check could not run (e.g. outside a git repository or git status failed), surface that notice first.
- Note that the read-only guard inspects tracked and untracked repository paths, but cannot detect modifications to gitignored files (such as .env or build output); never promise that gitignored files were untouched.
- If setup, installation, or authentication issues are encountered, direct the user to `/mcode:setup`.
- After presenting review findings, STOP and ask the user which findings to fix; never auto-fix.
