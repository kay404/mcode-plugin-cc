---
description: Run mcode's built-in review on uncommitted working tree changes
argument-hint: "[--wait] [--background]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run mcode's built-in review on uncommitted changes in the working tree.

Raw arguments:
$ARGUMENTS

Operating rules:
- If neither `--wait` nor `--background` was passed:
  - Check the size of the uncommitted change set:
    - Run `git diff --shortstat HEAD` to count changed lines (insertions and deletions).
    - Run `git status --porcelain` to count untracked files (lines starting with `??`).
  - If there are no uncommitted changes (empty shortstat and zero untracked files):
    - Run the companion review command directly without asking wait/background — it will print "No uncommitted changes to review."
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
- If `--wait` or `--background` was passed directly in raw arguments, run:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" review "$ARGUMENTS"`
- Otherwise run with the chosen flag before `"$ARGUMENTS"`:
  - If the user chose "Run in background":
    `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" review --background "$ARGUMENTS"`
  - If the user chose "Wait for results":
    `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" review --wait "$ARGUMENTS"`
- Present the companion output above verbatim and in full, without summarising or adding commentary.
- After presenting review findings, STOP and ask the user which findings to fix; never auto-fix without explicit user decision.
