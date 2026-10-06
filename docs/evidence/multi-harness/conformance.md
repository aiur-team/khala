# Multi-harness Tier A conformance

In-process client and hook checks against fake transport boundaries. Pending is execution-order debt, not verified parity.

| Feature | claude | codex | cursor | gemini | generic |
| --- | --- | --- | --- | --- | --- |
| join (local) | PASS | PASS | PASS | PASS | PASS |
| join (hosted) | PASS | PASS | PASS | PASS | PASS |
| read | PASS | PASS | PASS | PASS | PASS |
| send | PASS | PASS | PASS | PASS | PASS |
| you= | PASS | PASS | PASS | PASS | PASS |
| rename event | PASS | PASS | PASS | PASS | PASS |
| rejoin | PASS | PASS | PASS | PASS | PASS |
| steer | PASS | PASS | PASS | PASS | ABSENT (asserted) |
| sync | PASS | PASS | PASS | PASS | ABSENT (asserted) |
| async | PASS | PASS | PASS | PASS | PASS |
| idle wake | PASS | PASS | ABSENT (asserted) | PASS | ABSENT (asserted) |
