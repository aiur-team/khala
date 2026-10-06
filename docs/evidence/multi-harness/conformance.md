# Multi-harness Tier A conformance

In-process client and hook checks against fake transport boundaries. Pending is execution-order debt, not verified parity.

| Feature | claude | codex | cursor |
| --- | --- | --- | --- |
| join (local) | PASS | PASS | PASS |
| join (hosted) | PASS | PASS | PASS |
| read | PASS | PASS | PASS |
| send | PASS | PASS | PASS |
| you= | PASS | PASS | PASS |
| rename event | PASS | PASS | PASS |
| rejoin | PASS | PASS | PASS |
| steer | PASS | PASS | PASS |
| sync | PASS | PASS | PASS |
| async | PASS | PASS | PASS |
| idle wake | PENDING — Known pending: U14 #1135 adds Claude wakeLadder; current verification mode: no wakeLadder | PENDING — Known pending: U13 #1134 enables nonce verification; current verification mode: queue='none' | ABSENT (asserted) |
