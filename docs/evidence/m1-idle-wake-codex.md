# KM-112: Codex idle wake spike

Status: harness validated; native pane legs pending Executor preflight and serialization.
This is not a positive or negative native delivery result. No operator configuration
has been modified, no spike hooks have been trusted, and no native queue was sent.

## Versions and binary

Worker observation at 2026-10-02T05:06Z: `codex --version` reports
`codex-cli 0.160.0`; `codex queue --help` exits zero.
Worker launcher: `/home/everdred/.local/share/mise/installs/node/lts/bin/codex`.
The pane's version, thread ID and executable remain unmeasured.
Harness commit: `dfe8f38995ca9a6e3e332c454305adeae6efff55`.
Spike directory: `/home/everdred/.aiur/workspaces/aiur-team/khala/835/experiments/m1-idle-wake/codex`.

## Setup actually needed

The plain ESM harness requires Node 22 and Python 3.11+ for TOML validation.
Fixture tests use private `HOME`, `XDG_STATE_HOME` and `CODEX_HOME`.
The actual worker uses `/home/everdred/.codex`; it is outside this sandbox's
writable roots, as are the default state root and the shared `AGENT-MESSAGES.md`.
Executor assistance is required before L1. A private fixture home does not
substitute for the operator's same-thread TUI experiment.
Installer backups refuse overwrite. Teardown refuses unrelated semantic TOML or
hooks changes and preserves the backups for Executor reconciliation. Normal hook
trust records for the appended positional groups are removed during restoration.
Pre-install and post-teardown SHA-256 digests: pending L1/L7.

## Per-leg observations

| Leg | Timestamp | Observation | Result |
| --- | --- | --- | --- |
| Local suite | 2026-10-02T05:06Z | Six Node tests pass, including real child spawn, fixed notice/env, hook delivery, busy suppression, MCP JSON-RPC, byte restore | Harness only |
| L0 | pending | Pane identity and monitor readiness | Unmeasured |
| L1/L1b | pending | Hot hook loading versus resume and normal trust | Unmeasured |
| L1c | pending | MCP metadata and child environment | Unmeasured |
| L2 | pending | Ten-minute quiet idle wake and latency | Unmeasured |
| L3 | pending | Twenty-second tool completes before Stop delivery | Unmeasured |
| L3b | pending | Native queue during busy tool | Unmeasured |
| L4 | pending | Two entries 300 ms apart, once and in order | Unmeasured |
| L7 | pending | Restore checksums and removal of spike state | Not installed |

## L3b busy-queue behaviour

Unmeasured. The local busy guard test establishes only that `--if-idle` suppresses
queueing. It cannot establish whether native queue aborts, follows up or is ignored.

## Gaps

G-PANES and serialization with KM-111/KM-151 need Executor confirmation.
All pass/fail measurements will use the stub log and `spike-log.jsonl` timestamps.
Pane replies only corroborate those records. No native conclusion is inferred
from the earlier boundary evidence or fixture tests.

## Decisions for KM-147

Pending native legs. The exact decision block will be filled with measured values
only after those legs; unknown values must not be encoded as `no` or zero latency.
