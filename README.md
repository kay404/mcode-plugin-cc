# mcode plugin for Claude Code

A Claude Code plugin that hands work to MiniMax's `mcode` CLI agent headlessly (`mcode exec --output-format stream-json`) and brings results back into the Claude session.

Design inspired by `openai/codex-plugin-cc`; no code copied.

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

```bash
/plugin marketplace add kay404/mcode-plugin-cc
/plugin install mcode@mcode-plugin-cc
/mcode:setup
```

---

## Commands

### `setup`

Checks that Node meets version requirements, `mcode` is on `PATH` with headless mode supported, and an authenticated model provider is active. Never prints API keys, masked keys, or provider URLs.

- **Arguments**: `[--json]`
- **Defaults**: prints human-readable verification steps and a final verdict (`ready`, `ready (login unverified)`, or `not-ready`).
- **Example**:
  ```bash
  /mcode:setup
  ```

### `delegate`

Hands an investigation, diagnosis, or implementation task to `mcode`. By default, delegations run with write intent in the foreground and stream progress updates.

- **Arguments**: `[--resume] [--fresh] [--read-only] [--full] [--background] [--model <provider/model>] [--effort <low|medium|high|xhigh|max>] [--json] <task description>`
- **Defaults**:
  - Permission: defaults to `smart`. `--full` is granted only on explicit user request. `off` is permanently disabled in the plugin for safety.
  - Read-only: defaults to false (write intent enabled). When `--read-only` is set, prompt instructions forbid file modifications and the workspace guard checks for alterations.
  - Session continuation: if neither `--resume` nor `--fresh` is passed and a resumable mcode session exists from a previous completed delegate Job in this Claude session, the command asks once:
    - Option 1 (Recommended): "Continue the current mcode session" (`--resume`)
    - Option 2: "Start a new mcode session" (`--fresh`)
    Resuming is refused with an error if another delegation in this Claude session is currently running or queued.
  - Model & effort: left unset so `mcode` defaults apply, unless explicitly specified.
  - Execution mode: runs in foreground by default. Passing `--background` starts a detached background worker and returns the Job ID immediately.
- **Examples**:
  ```bash
  /mcode:delegate Fix the failing authentication unit tests
  /mcode:delegate --read-only Investigate why the cache eviction loop leaks memory
  /mcode:delegate --background Implement user profile export
  /mcode:delegate --resume Apply the second recommendation
  ```

### `review`

Runs `mcode`'s built-in headless review (`mcode exec review`) on uncommitted changes in the working tree. Not model-invocable (`disable-model-invocation: true`; Claude cannot invoke this on its own).

- **Arguments**: `[--wait] [--background] [--json]`
- **Defaults**:
  - Change check: checks `git diff --shortstat HEAD` and `git status --porcelain`. If there are no uncommitted changes, it short-circuits immediately with "No uncommitted changes to review."
  - Wait vs background prompt: if neither `--wait` nor `--background` was passed, prompts once based on change set size:
    - Large change (>200 changed lines or >10 untracked files):
      - Option 1 (Recommended): "Run in background"
      - Option 2: "Wait for results"
    - Small change (<=200 changed lines and <=10 untracked files):
      - Option 1 (Recommended): "Wait for results"
      - Option 2: "Run in background"
  - Interactive decision: after presenting review findings verbatim, Claude stops and asks the user which findings to fix; findings are never auto-fixed without approval.
- **Examples**:
  ```bash
  /mcode:review
  /mcode:review --wait
  /mcode:review --background
  ```

### `adversarial-review`

Runs a structured, skeptical critique driven by the plugin's adversarial prompt template and JSON schema. Not model-invocable (`disable-model-invocation: true`).

- **Arguments**: `[--base <ref> | --plan <path>] [--wait | --background] [--json] [focus text…]`
- **Defaults & targets**:
  - Working tree (default): uncommitted tracked and untracked changes.
  - Branch target (`--base <ref>`): diff between base ref and HEAD (`<ref>...HEAD`).
  - Plan document (`--plan <path>`): reviews an architectural design or specification document at `<path>`.
  - Focus text: any remaining arguments are passed as targeted review instructions (e.g. concurrency, backward compatibility).
  - Sizing & inlining: small diffs (<=2000 lines and <=200 KB) are inlined directly into the review prompt. Large changes instruct `mcode` to inspect files itself using read-only git commands or file tools.
  - Wait vs background prompt: if neither flag is passed, asks once. For `--plan`, "Wait for results" is recommended first; for working tree or branch targets, changes exceeding 200 lines recommend "Run in background" first.
  - Output shape: structured schema output comprising `verdict` (`approve` or `needs-attention`), `summary`, `findings` (sorted by severity: `critical`, `high`, `medium`, `low`, with file path, line range, confidence, and recommendation), and `next_steps`. Schema-invalid responses fail the Job.
- **Examples**:
  ```bash
  /mcode:adversarial-review Check for race conditions in token renewal
  /mcode:adversarial-review --base origin/main Focus on database migrations
  /mcode:adversarial-review --plan docs/storage-v2-spec.md
  ```

### `status`

Lists Jobs belonging to the current Claude session or inspects the progress of a specific Job.

- **Arguments**: `[job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]`
- **Defaults**:
  - Without `job-id`: lists Jobs in the current Claude session showing ID, kind, state, age, and progress preview.
  - With `job-id`: displays Job metadata and the last 10 progress log lines. Job IDs can be specified by unique prefix.
  - `--wait`: waits until the Job reaches a terminal state (`completed`, `failed`, or `cancelled`). Defaults to a 240,000 ms timeout (configurable with `--timeout-ms`). If no `job-id` is provided, waits on the newest Job in the session.
  - `--all`: lists or inspects Jobs across all Claude sessions in this workspace.
- **Examples**:
  ```bash
  /mcode:status
  /mcode:status delegate-m1abc
  /mcode:status --wait
  /mcode:status --all
  ```

### `result`

Prints the full rendered output of a finished Job.

- **Arguments**: `[job-id] [--all] [--json]`
- **Defaults**:
  - Without `job-id`: returns output for the newest finished Job in the current Claude session.
  - With `job-id`: returns output for the specified Job (supports unique prefix). Errors if the Job is still running or queued.
  - `--all`: allows retrieving finished Jobs from other Claude sessions in the same workspace.
- **Examples**:
  ```bash
  /mcode:result
  /mcode:result delegate-m1abc
  ```

### `cancel`

Cancels an active (running or queued) Job and its process group.

- **Arguments**: `[job-id] [--json]`
- **Defaults**:
  - Without `job-id`: cancels the newest active Job in the current Claude session.
  - With `job-id`: cancels the specified Job (supports unique prefix).
  - Termination: sends `SIGTERM` to the process group, escalates to `SIGKILL` if needed, and records status as `cancelled`.
- **Examples**:
  ```bash
  /mcode:cancel
  /mcode:cancel delegate-m1abc
  ```

---

## Read-Only is Best-Effort (Important Limitation)

The plugin provides a soft, best-effort read-only guarantee. **It is not an OS or filesystem sandbox.**

- Enforced through two layers:
  1. A prompt contract instructing `mcode` not to modify, create, or delete files or execute mutating commands.
  2. A pre- and post-execution workspace check (`workspace-guard`) that captures git status and file fingerprints.
- If changes are detected after a read-only Job, the command flags a **read-only violation** listing the modified paths at the very top of the output.
- **Files are never automatically reverted.** The user remains in full control of their working tree.
- **Limitations**:
  - Outside a git repository, the workspace guard cannot verify file state and reports that the check could not run.
  - Files ignored by `.gitignore` (such as build artifacts or `.env` files) are not scanned to keep execution bounded.

---

## Jobs and Sessions

- **Scoping**: Jobs are scoped to the active Claude session via `MCODE_CLAUDE_SESSION_ID` (injected at session start).
- **Storage**: Job state and append-only progress logs are saved per workspace in the plugin data directory under `state/<workspace-slug>-<hash>/jobs`.
- **Index Retention**: Bounded at the 50 most recent Jobs per workspace. Older Job records and logs are deleted automatically.
- **Session Lifecycle**:
  - At session end, any still running or queued Jobs started by that session are terminated and marked `cancelled`.
  - Finished Jobs are preserved so `/mcode:result` and follow-up `/mcode:delegate --resume` continue to work when resuming the session with `claude --continue`.
- **mcode Session Handoff**: Every delegation and review result concludes with the mcode session ID and interactive command:
  ```
  mcode --session <session-id>
  ```
  If headless execution fails due to interactive prompts (questionnaires or permission requests), the error message provides this command so you can resume the session directly in the mcode TUI.

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
  Executes the test suite using a fake `mcode` on `PATH` driven by recorded JSONL streaming fixtures. Requires no network access or API credentials.
- **Check version synchronization**:
  ```bash
  npm run version-check
  ```
  Ensures version parity between `package.json`, `.claude-plugin/marketplace.json`, and `plugins/mcode/.claude-plugin/plugin.json`.
- **Opt-in real mcode smoke test**:
  ```bash
  MCODE_SMOKE=1 npm run smoke
  ```
  Runs a live smoke test against the real `mcode` binary on `PATH` using an isolated temporary git repository and clean plugin data directory. Skipped by default when `MCODE_SMOKE=1` is omitted.

---

## License

MIT
