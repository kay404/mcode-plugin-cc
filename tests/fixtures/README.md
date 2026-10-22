# Test Fixtures

This directory contains streaming JSONL fixtures used by the test harness to simulate `mcode exec` output.

## Provenance

- **`success.stream.jsonl`**: Real (recorded with `mcode` 0.6.12).
- **`invalid-model.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 using an unavailable model).
- **`permission-denied-handled.stream.jsonl`**: Real (recorded with `mcode` 0.6.12 probing an external path write; scrubbed).
- **`needs-interaction.stream.jsonl`**: Hand-written from mcode source knowledge (`INTERACTION_NOT_AVAILABLE` error code; to be re-recorded).
- **`timeout.stream.jsonl`**: Hand-written from mcode source knowledge (`status: "timeout"`; to be re-recorded).
- **`limit-exceeded.stream.jsonl`**: Hand-written from mcode source knowledge (`status: "limit_exceeded"`; to be re-recorded).

## Smart-Permission Behaviour Finding

In headless smart mode (`mcode exec --permission smart`), writes outside the working directory fail the tool call with `HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.`

In this scenario:
1. The tool execution fails with `HOST_CAPABILITY_UNAVAILABLE`.
2. `mcode` detects this failure internally and recovers (falling back to workspace operations or reporting the constraint).
3. The overall run completes with `result.status: "succeeded"`.
4. The plugin runner maps this to Job status `completed`.
