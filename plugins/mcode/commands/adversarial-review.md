---
description: Run an adversarial review on working tree changes, a branch, or a plan document
argument-hint: "[--base <ref> | --plan <path>] [--wait | --background] [focus…]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial review on working tree changes, a branch, or a plan document.

Raw arguments:
$ARGUMENTS

Operating rules:
- If neither `--wait` nor `--background` was passed:
  - Determine the target from arguments:
    - If `--plan <path>` was passed:
      - Ask once using `AskUserQuestion`:
        - Option 1 (Recommended): "Wait for results"
        - Option 2: "Run in background"
      - If the user chooses "Wait for results", run in foreground.
      - If the user chooses "Run in background", run with `--background`.
    - If `--base <ref>` was passed:
      - Run `git diff --shortstat <ref>...HEAD` to count changed lines.
      - If there are no changes (empty shortstat):
        - Run the companion command directly without asking wait/background — it will print "No changes between <ref> and HEAD."
      - Size threshold:
        - Large change (>200 changed lines):
          - Ask once using `AskUserQuestion`:
            - Option 1 (Recommended): "Run in background"
            - Option 2: "Wait for results"
          - If the user chooses "Run in background", run with `--background`.
          - If the user chooses "Wait for results", run in foreground.
        - Small change (<=200 changed lines):
          - Ask once using `AskUserQuestion`:
            - Option 1 (Recommended): "Wait for results"
            - Option 2: "Run in background"
          - If the user chooses "Wait for results", run in foreground.
          - If the user chooses "Run in background", run with `--background`.
    - Otherwise (working tree target):
      - Check the size of the uncommitted change set:
        - Run `git diff --shortstat HEAD` to count changed lines (insertions and deletions).
        - Run `git status --porcelain` to count untracked files (lines starting with `??`).
      - If there are no uncommitted changes (empty shortstat and zero untracked files):
        - Run the companion command directly without asking wait/background — it will print "No uncommitted changes to review."
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
- Run the companion adversarial review command:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcode-companion.mjs" adversarial-review "$ARGUMENTS"`
- Present the companion output above verbatim and in full, without summarising or adding commentary.
- After presenting adversarial review findings, STOP and ask the user which findings to fix; never auto-fix without explicit user decision.
