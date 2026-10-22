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
- **`review-needs-changes.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running `mcode exec review --cwd <git toplevel> --permission smart --output-format stream-json` on uncommitted changes with a planted bug; scrubbed and trimmed of `item.updated` streaming deltas).
- **`review-pass.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running `mcode exec review --cwd <git toplevel> --permission smart --output-format stream-json` on clean uncommitted changes; scrubbed and trimmed of `item.updated` streaming deltas).
- **`adversarial-review-working-tree.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running `mcode exec --cwd <git toplevel> --permission smart --output-format stream-json --output-schema <schema-path> --input -` on uncommitted working-tree changes with a planted bug; scrubbed and trimmed of standalone streaming delta events (`item.updated` reasoning, text, tool_call deltas)).
- **`adversarial-review-branch.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running `mcode exec --cwd <git toplevel> --permission smart --output-format stream-json --output-schema <schema-path> --input -` on branch changes against base `main` with a planted bug; scrubbed and trimmed of standalone streaming delta events (`item.updated` reasoning, text, tool_call deltas)).
- **`adversarial-review-plan.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running `mcode exec --cwd <git toplevel> --permission smart --output-format stream-json --output-schema <schema-path> --input -` on a plan document with planted defects; scrubbed and trimmed of standalone streaming delta events (`item.updated` reasoning, text, tool_call deltas)).
- **`adversarial-review-schema-invalid.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 running with `--output-schema` where model emitted output that failed schema validation; scrubbed and trimmed of standalone streaming delta events (`item.updated` reasoning, text, tool_call deltas)).

## Smart-Permission Behaviour Finding

In headless smart mode (`mcode exec --permission smart`), writes outside the working directory fail the tool call with `HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.`

In this scenario:
1. The tool execution fails with `HOST_CAPABILITY_UNAVAILABLE`.
2. `mcode` detects this failure internally and recovers (falling back to workspace operations or reporting the constraint).
3. The overall run completes with `result.status: "succeeded"`.
4. The plugin runner maps this to Job status `completed`.

## Cancelled Run Finding

A real run terminated by SIGTERM mid-run emits no `exec.completed` event on stdout, writes `mcode exec failed: Execution was cancelled.` to stderr, and exits with code 130. The plugin runner maps mid-run termination to Job status `cancelled`.

## Review Permission & Read-Only Behaviour Finding

Probing `mcode exec review --cwd <git toplevel> --output-format stream-json` with `--permission smart` versus `--permission full` on a repository with uncommitted changes containing a planted defect showed:
1. `mcode exec review` accepts `--permission full` without error. Whether it changes which tools run during a review was not observed.
2. Under `--permission smart`, tool actions that would prompt for approval in interactive mode (such as executing arbitrary node scripts or out-of-bounds writes) fail with `HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.`, which mcode recovers from.
3. Under both `--permission smart` and `--permission full`, `mcode exec review` did not edit or revert the planted bug in the working tree (`git diff` remained byte-identical before and after). The built-in review intent limits itself to inspecting files and returning findings rather than modifying files.

## Adversarial Review & Output Schema Behaviour Finding

Probing `mcode exec --output-schema <path> --output-format stream-json` across working tree, branch, and plan targets showed:
1. When execution succeeds, `exec.completed` delivers the structured answer as a parsed JSON object in `event.result.output` (not a JSON string), matching the schema properties (`verdict`, `summary`, `findings`, `next_steps`). `result.status` is `"succeeded"` and the process exits with code 0.
2. When the model output does not conform to `--output-schema` or cannot be parsed as JSON, `mcode` fails the run itself. In `exec.completed`, `result.status` is `"failed"` and `result.error` has `code: "STRUCTURED_OUTPUT_INVALID"`, `category: "runtime"`, and `message` detailing the missing properties or JSON error. `result.output` is undefined. The process exits with code 4 and logs the failure to stderr.
