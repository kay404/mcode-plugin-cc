# Test Fixtures

This directory contains streaming JSONL fixtures used by the test harness to simulate `mcode exec` output.

## Provenance

- **`success.stream.jsonl`**: Real (recorded with `mcode` 0.6.12).
- **`invalid-model.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 using an unavailable model).
- **`permission-denied-handled.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 probing an external path write; scrubbed).
- **`needs-interaction.stream.jsonl`**: Hand-written from mcode source knowledge (`INTERACTION_NOT_AVAILABLE` error code; to be re-recorded).
- **`timeout.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 using `--timeout 1s` on a long prompt).
- **`limit-exceeded.stream.jsonl`**: Hand-written from mcode source knowledge (`status: "limit_exceeded"`; to be re-recorded).
- **`provider-list.json`**: Fake fixture containing only allowed fields (both key and OAuth providers; this machine's shape) with fake values.
- **`provider-list-key-only.json`**: Fake fixture containing only a verified key provider.
- **`provider-list-oauth-only.json`**: Fake fixture containing only an unverified OAuth provider.
- **`provider-list-none-active.json`**: Fake fixture containing no active providers.
- **`review-needs-changes.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running `mcode exec review --cwd <git toplevel> --permission smart --output-format stream-json` on uncommitted changes with a planted bug; scrubbed).
- **`review-pass.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running `mcode exec review --cwd <git toplevel> --permission smart --output-format stream-json` on clean uncommitted changes; scrubbed).

## Smart-Permission Behaviour Finding

In headless smart mode (`mcode exec --permission smart`), writes outside the working directory fail the tool call with `HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.`

In this scenario:
1. The tool execution fails with `HOST_CAPABILITY_UNAVAILABLE`.
2. `mcode` detects this failure internally and recovers (falling back to workspace operations or reporting the constraint).
3. The overall run completes with `result.status: "succeeded"`.
4. The plugin runner maps this to Job status `completed`.

## Cancelled Run Finding

A real run terminated by SIGTERM mid-run emits no `exec.completed` event on stdout, writes `mcode exec failed: Execution was cancelled.` to stderr, and exits with code 130. The plugin runner maps mid-run termination to Job status `cancelled`.

## Review Inherently Read-Only Finding

When running `mcode exec review --cwd <git toplevel> --permission smart --output-format stream-json`, `mcode` inspects the working tree's uncommitted changes without modifying any files:
1. Even when provided with `--permission smart` and uncommitted changes containing a planted defect, `mcode exec review` never edits or mutates files in the working tree (`git diff` is byte-identical before and after the review).
2. During review, probing commands attempting execution (such as `node -e ...`) fail under headless smart mode with `HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.`, which `mcode` handles gracefully without side effects.
3. Therefore, `mcode exec review` is inherently read-only: it only performs read/inspection operations on the working tree.
