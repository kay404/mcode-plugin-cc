# mcode plugin for Claude Code

A Claude Code plugin that hands work to MiniMax's `mcode` CLI agent headlessly (`mcode exec --output-format stream-json`) and brings results back into the Claude session.

Design inspired by openai/codex-plugin-cc; no code copied.

---

## Requirements

- **Operating System**: macOS or Linux (Windows is not supported).
- **Node.js**: `>=22.19 <23 || >=24 <27`.
- **mcode CLI**: installed and authenticated with a working provider.
  - Check your environment status with `/mcode:setup`.
  - Authenticate if needed using `! mcode login`.
  - If `mcode` is missing, install it with the official install command:
    ```bash
    npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3 --registry=https://registry.npmjs.org/
    ```

---

## Install

Add the marketplace and install the plugin from inside Claude Code:

```text
/plugin marketplace add kay404/mcode-plugin-cc
/plugin install mcode@mcode-plugin-cc
/mcode:setup
```

---

## Commands

### `setup`

Checks that Node meets version requirements (`>=22.19 <23 || >=24 <27`), `mcode` is on `PATH` with headless mode supported, and an authenticated model provider is active. Never prints API keys, masked keys, or provider URLs.

- **Arguments**: `[--json]`
- **Defaults**: prints verdict first (`ready`, `ready (login unverified)`, or `not-ready`), then the installed `mcode` version, active providers, and a next step or hint (no step-by-step check list).
- **Example**:
  ```text
  /mcode:setup
  ```

### `delegate`

Hands an investigation, diagnosis, or implementation task to `mcode`. By default, delegations run with write intent and the command waits for the result.

Claude may also invoke the `mcode-delegate` agent autonomously for substantial or stuck work. Continuation phrasing in the prompt (such as "continue", "keep going", "apply the top fix", or "dig deeper") automatically routes to `--resume` and sends only the delta instruction.

- **Arguments**: `[--resume] [--fresh] [--read-only] [--full] [--background] [--model <provider/model>] [--effort <low|medium|high|xhigh|max>] [--json] <task description>`
- **Defaults & rules**:
  - Permission: defaults to `smart`. `--full` is granted only on explicit user request. `off` is permanently disabled in the plugin for safety.
  - Read-only: defaults to false (write intent enabled). When `--read-only` is set, prompt instructions forbid file modifications and the workspace guard checks for alterations before and after execution.
  - Session continuation: if neither `--resume` nor `--fresh` is passed and a resumable mcode session exists from the newest finished delegate Job (completed, failed, or cancelled) of this Claude session that has an mcode session ID, the command asks once:
    - Option 1 (Recommended): "Continue the current mcode session" (`--resume`)
    - Option 2: "Start a new mcode session" (`--fresh`)
  - Error conditions:
    - Combining `--resume` and `--fresh` fails with:
      `Error: Cannot combine --resume and --fresh (they are mutually exclusive).`
    - Specifying `--resume` when no candidate exists fails with:
      `Error: No resumable mcode session found for this Claude session.`
    - Resuming while another delegation in this Claude session is running or queued is refused with an error.
  - Model & effort: left unset so `mcode` defaults apply, unless explicitly specified.
  - Execution mode: the `mcode-delegate` agent always starts a background Job (a detached worker) and waits for it with `status --wait` in calls of at most 9 minutes, then prints `result`. Long runs are therefore not cut off by Claude Code's Bash timeout, and interrupting Claude does not stop the Job; use `/mcode:cancel` for that. Passing `--background` returns the Job ID immediately instead of waiting.
  - Calling the companion directly without `--background` (for example from a script) still runs in the foreground and streams progress lines to stderr.
- **Examples**:
  ```text
  /mcode:delegate Fix the failing authentication unit tests
  /mcode:delegate --read-only Investigate why the cache eviction loop leaks memory
  /mcode:delegate --background Implement user profile export
  /mcode:delegate --resume Apply the second recommendation
  ```

### `review`

Runs `mcode`'s built-in headless review (`mcode exec review`) on uncommitted changes in the working tree. Not model-invocable (`disable-model-invocation: true`; Claude cannot invoke this on its own). Always runs read-only with the workspace guard.

Outside a git repository, the command exits with:
`Error: Not a git repository.`

- **Arguments**: `[--wait] [--background] [--json]`
- **Defaults & rules**:
  - Error condition: combining `--wait` and `--background` fails with:
    `Error: Cannot combine --wait and --background (they are mutually exclusive).`
  - Change check: before asking anything, the command checks the change set using `git diff --shortstat HEAD` and `git status --porcelain`. If there are no uncommitted changes, it runs the companion directly without asking wait/background.
  - Clean-tree exit: the companion script also performs its own early exit check via `git status --porcelain` and prints:
    `No uncommitted changes to review.`
  - Wait vs background prompt: if neither `--wait` nor `--background` was passed and changes exist, the command prompts once based on change set size:
    - Large change (>200 changed lines OR >10 untracked files):
      - Option 1 (Recommended): "Run in background"
      - Option 2: "Wait for results"
    - Small change (<=200 changed lines AND <=10 untracked files):
      - Option 1 (Recommended): "Wait for results"
      - Option 2: "Run in background"
  - Interactive decision: after presenting review findings verbatim, Claude stops and asks the user which findings to fix; findings are never auto-fixed without approval.
- **Examples**:
  ```text
  /mcode:review
  /mcode:review --wait
  /mcode:review --background
  ```

### `adversarial-review`

Runs a structured, skeptical critique driven by the plugin's adversarial prompt template and JSON schema. Not model-invocable (`disable-model-invocation: true`). Always runs read-only with the workspace guard.

Outside a git repository, the working-tree and `--base` targets exit with:
`Error: Not a git repository.`
The `--plan` target works anywhere.

- **Arguments**: `[--base <ref> | --plan <path>] [--wait | --background] [--json] [focus text…]`
- **Defaults & rules**:
  - Flags before focus: all option flags must precede the focus text. Everything from the first non-flag argument onward is treated as focus text.
  - Error conditions:
    - Combining `--base` and `--plan` fails with:
      `Error: Cannot combine --base and --plan (they are mutually exclusive).`
    - Combining `--wait` and `--background` fails with:
      `Error: Cannot combine --wait and --background (they are mutually exclusive).`
  - Targets:
    - Working tree (default): uncommitted tracked and untracked changes.
    - Branch target (`--base <ref>`): diff between base ref and HEAD (`<ref>...HEAD`).
    - Plan document (`--plan <path>`): reviews a specification or design document at `<path>`.
  - Change check: when reviewing the working tree or a branch, if there are no changes, the command skips the wait/background question and invokes the companion directly to print `No uncommitted changes to review.` or `No changes between <ref> and HEAD.`
  - Wait vs background prompt: if neither flag is passed and changes exist, asks once:
    - For `--plan`: Option 1 (Recommended) is "Wait for results".
    - For working tree or branch: changes exceeding 200 lines (or >10 untracked files for working tree) recommend "Run in background" first; otherwise "Wait for results" is recommended first.
  - Sizing & inlining: small diffs (<=2000 lines and <=200 KB) are inlined directly into the review prompt. Large changes instruct `mcode` to inspect files itself using read-only git commands or file tools.
  - Output shape: structured schema output comprising `verdict` (`approve` or `needs-attention`), `summary`, `findings` (sorted by severity: `critical`, `high`, `medium`, `low`, with file path, line range, confidence, and recommendation), and `next_steps`. Schema-invalid responses fail the Job.
- **Examples**:
  ```text
  /mcode:adversarial-review Check for race conditions in token renewal
  /mcode:adversarial-review --base origin/main Focus on database migrations
  /mcode:adversarial-review --plan docs/storage-v2-spec.md
  ```

### `status`

Lists Jobs belonging to the current Claude session or inspects the progress of a specific Job.

- **Arguments**: `[job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]`
- **Defaults & rules**:
  - Without `job-id`: lists Jobs in the current Claude session showing ID, kind, state, age, and progress preview.
  - With `job-id`: displays Job metadata and the last 10 progress log lines. Job IDs can be specified by unique prefix.
  - Waiting: passing `--wait` or `--timeout-ms <ms>` (which on its own implies waiting) blocks until the Job reaches a terminal state (`completed`, `failed`, or `cancelled`). Defaults to a 240,000 ms timeout. If no `job-id` is provided, waits on the newest Job in the session.
  - `--all`: lists or inspects Jobs across all Claude sessions in this workspace.
- **Examples**:
  ```text
  /mcode:status
  /mcode:status delegate-m1abc
  /mcode:status --wait
  /mcode:status --timeout-ms 60000
  /mcode:status --all
  ```

### `result`

Prints the full rendered output of a finished Job.

- **Arguments**: `[job-id] [--all] [--json]`
- **Defaults & rules**:
  - Without `job-id`: returns output for the newest finished Job in the current Claude session.
  - With `job-id`: returns output for the specified Job (supports unique prefix). Errors if the Job is still running or queued.
  - `--all`: allows retrieving finished Jobs from other Claude sessions in the same workspace.
- **Examples**:
  ```text
  /mcode:result
  /mcode:result delegate-m1abc
  ```

### `cancel`

Cancels an active (running or queued) Job in the current Claude session. Only targets Jobs of the current Claude session (has no `--all` option).

- **Arguments**: `[job-id] [--json]`
- **Defaults & rules**:
  - Without `job-id`: cancels the newest active Job in the current Claude session.
  - With `job-id`: cancels the specified Job (supports unique prefix).
  - Termination: sends `SIGTERM` to the process group, escalates to `SIGKILL` if needed, and records status as `cancelled`.
- **Examples**:
  ```text
  /mcode:cancel
  /mcode:cancel delegate-m1abc
  ```

---

## Read-Only is Best-Effort (Important Limitation)

The plugin provides a soft, best-effort read-only guarantee. **It is not an OS or filesystem sandbox.**

- Scope: applied to `/mcode:review`, `/mcode:adversarial-review`, and `/mcode:delegate --read-only`.
- Enforced through two layers:
  1. A prompt contract instructing `mcode` not to modify, create, or delete files or execute mutating commands.
  2. A pre- and post-execution workspace check (`workspace-guard`) that captures git status, HEAD position, stash state, and file fingerprints.
- If alterations are detected, the command flags a **read-only violation** listing the modified paths, HEAD movement, or stash change at the very top of the output.
- Files are never automatically reverted.
- Limitations:
  - Outside a git repository, the workspace guard cannot verify file state and reports that the check could not run. (`/mcode:review` and the working-tree / `--base` targets of `/mcode:adversarial-review` refuse to run outside git).
  - Files ignored by `.gitignore` (such as build artifacts or `.env` files) are not scanned to keep execution bounded.

---

## Jobs and Sessions

- **Scoping**: Jobs are scoped to the active Claude session via `MCODE_CLAUDE_SESSION_ID` (injected at session start).
- **Storage**: Job state and progress logs are saved per workspace under `<plugin data>/state/<repo-slug>-<hash>/`.
  - `state.json`: bounded index of Job summaries.
  - `jobs/<id>.json`: complete Job record.
  - `jobs/<id>.log`: append-only progress log.
  - When `MCODE_PLUGIN_DATA` is unset, storage falls back to `$TMPDIR/mcode-companion/<repo-slug>-<hash>/`.
- **Index Retention**: Bounded at the 50 most recent Jobs per workspace. Older Job records and logs are deleted automatically.
- **Session Lifecycle**:
  - At session end, running or queued Jobs started by that session are terminated and marked `cancelled`.
  - Finished Jobs are preserved so `/mcode:result` and follow-up `/mcode:delegate --resume` continue to work when resuming the session with `claude --continue`.
- **Stopped Jobs**: a Job stopped by `SIGTERM`, `SIGINT` or `SIGHUP` is recorded as `cancelled`. If the process running a Job dies without recording anything (for example `SIGKILL`), the next `status`, `result`, `cancel` or `delegate` call marks it `failed` with reason `process-lost`; a `status --wait` already in progress notices within a second. The same happens to a background Job whose worker has not started within a minute. Changes it already made stay in the working tree. A `SIGKILL` cannot be forwarded, so after killing a foreground companion that way the `mcode` process it started may keep running and editing files; stop it yourself. The mcode session id is recorded as soon as mcode reports it, so such a Job can still be continued with `--resume` or opened with `mcode --session <id>`.
- **Session Footer**: Results conclude with an mcode session footer whenever an mcode session ID was captured:
  ```text
  ---
  mcode session: <session-id>
  To open this session in the mcode TUI: mcode --session <session-id>
  ```
  If headless execution fails due to interactive prompts (such as questionnaires or permission requests), the failure output includes this command so you can continue the session in the mcode TUI.

---

## Not Included (Out of Scope)

The following capabilities are intentionally outside the scope of this plugin:

- Stop-time review gate (blocking Claude Stop hooks until mcode approves).
- Quick-ask / single-shot lightweight question commands.
- Agent Client Protocol (ACP) server integration or plan mode.
- Windows platform support.
- Automatic installation or background updating of the `mcode` binary.
- Passthrough flags for `--timeout` or `--max-steps` (mcode defaults govern execution).

---

## Development

- **Run unit tests**:
  ```bash
  npm test
  ```
  Executes the test suite using a fake `mcode` on `PATH` driven by recorded JSONL streaming fixtures. Requires no network access or credentials.
  Streaming JSONL test fixtures are mostly recorded from the real mcode; a few are hand-written from mcode source specifications (see `tests/fixtures/README.md`).
- **Check version synchronization**:
  ```bash
  npm run version-check
  ```
  Ensures version parity between `package.json`, `.claude-plugin/marketplace.json`, and `plugins/mcode/.claude-plugin/plugin.json`.
- **Opt-in real mcode smoke test**:
  ```bash
  MCODE_SMOKE=1 npm run smoke
  ```
  Runs a live smoke test against the real `mcode` binary on `PATH` using an isolated temporary git repository and clean plugin data directory.
  The smoke test uses the real configured provider: requires network access, a working login or API key, and consumes quota. Skipped by default when `MCODE_SMOKE=1` is omitted.

---

## License

MIT
