---
description: Run mcode's built-in review on uncommitted working tree changes
argument-hint: "[--wait] [--background]"
disable-model-invocation: true
allowed-tools: Bash(node:*,git:*), AskUserQuestion
---

Run mcode's built-in review on uncommitted changes in the working tree.

Raw arguments:
$ARGUMENTS

Operating rules:
- If neither `--wait` nor `--background` was passed:
  - Check the size of the uncommitted change set:
    - Run `git diff --shortstat HEAD` to count changed lines (insertions and deletions).
    - Run `git status --porcelain` to count untracked files (lines starting with `??`).
  - Size threshold:
    - Large change (>200 changed lines or >10 untracked files):
      - Ask once using `AskUserQuestion`:
        - Option 1 (Recommended): "Run in background"
        - Option 2: "Wait for results"
      - If the user chooses "Run in background", run with `--background`.
      - If the user chooses "Wait for results", run in foreground.
    - Small change (<=200 changed lines and <=10 untracked files):
      - Ask once using `AskUserQuestion`:
        - Option 1 (Recommended): "Wait for results"
        - Option 2: "Run in background"
      - If the user chooses "Wait for results", run in foreground.
      - If the user chooses "Run in background", run with `--background`.
- If `--wait` was passed, run in foreground without `--background`.
- If `--background` was passed, run with `--background`.
- Run the companion review command:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" review $ARGUMENTS`
- Present the companion output above verbatim and in full, without summarising or adding commentary.
- After presenting review findings, STOP and ask the user which findings to fix; never auto-fix without explicit user decision.
