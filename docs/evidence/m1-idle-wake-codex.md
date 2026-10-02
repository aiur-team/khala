# KM-112: Codex idle wake spike

Status: prototype complete; every manual leg deferred to KM-151 live acceptance
by the Executor direction on #835 (comment 5945958770, @its-everdred, repository CODEOWNER).
This is not a positive or negative native delivery result. No operator configuration
has been modified, no spike hooks have been trusted, and no native queue was sent.

## Versions and binary

Worker observation at 2026-10-02T05:06Z: `codex --version` reports
`codex-cli 0.160.0`; `codex queue --help` exits zero.
Worker launcher: `/home/everdred/.local/share/mise/installs/node/lts/bin/codex`.
The pane's version, thread ID and executable are deferred to KM-151 live acceptance.
Harness commit: `dfe8f38995ca9a6e3e332c454305adeae6efff55`.
Spike directory: `/home/everdred/.aiur/workspaces/aiur-team/khala/835/experiments/m1-idle-wake/codex`.

## Setup actually needed

The plain ESM harness requires Node 22 and Python 3.11+ for TOML validation.
Fixture tests use private `HOME`, `XDG_STATE_HOME` and `CODEX_HOME`.
The actual worker uses `/home/everdred/.codex`; it is outside this sandbox's
writable roots, as are the default state root and the shared `AGENT-MESSAGES.md`.
The Executor explicitly prohibited live installation for this ticket and moved the
same-thread TUI experiment to KM-151. Fixture installation is the only installation run.
Installer backups refuse overwrite. Teardown refuses unrelated TOML values, comments, formatting or
hooks changes and preserves the backups for Executor reconciliation. Normal hook
trust records for the appended positional groups are removed during restoration.
Live pre-install and post-teardown SHA-256 digests: deferred to KM-151 live acceptance;
this ticket did not install, so there is no live restoration to perform.

## Per-leg observations

| Leg | Timestamp | Observation | Result |
| --- | --- | --- | --- |
| Local suite | 2026-10-02T05:06Z | Seven Node tests pass, including real child spawn, fixed notice/env, hook delivery, busy suppression, MCP JSON-RPC, byte restore | Harness only |
| L0 | — | Pane identity and monitor readiness | deferred to KM-151 live acceptance |
| L1/L1b | — | Hot hook loading versus resume and normal trust | deferred to KM-151 live acceptance |
| L1c | — | MCP metadata and child environment | deferred to KM-151 live acceptance |
| L2 | — | Ten-minute quiet idle wake and latency | deferred to KM-151 live acceptance |
| L3 | — | Twenty-second tool completes before Stop delivery | deferred to KM-151 live acceptance |
| L3b | — | Native queue during busy tool | deferred to KM-151 live acceptance |
| L4 | — | Two entries 300 ms apart, once and in order | deferred to KM-151 live acceptance |
| L7 | — | Restore checksums and removal of spike state | deferred to KM-151 live acceptance; not installed here |

## L3b busy-queue behaviour

Unmeasured. The local busy guard test establishes only that `--if-idle` suppresses
queueing. It cannot establish whether native queue aborts, follows up or is ignored.

## Gaps

Native timing, ten-minute idle behavior, burst delivery and pane environment remain
deferred to KM-151 live acceptance. Fixture tests do not establish these native outcomes.
The defaults below are inherited evidence or Executor assumptions, not observations
from this spike. In particular, the source does not measure hot reload, busy-queue
behavior, child CODEX_THREAD_ID, or idle latency.

## Decisions for KM-147

These are provisional integration defaults requested by the Executor, not measured
KM-112 results. The private TUI proof in [the existing native boundary record](codex-0160-native-boundary.md)
establishes a content-free idle queue turn and normal hook trust. Its manual MCP
proof establishes `_meta.threadId` equals the native thread, and its TUI proof
requires explicit HOME/XDG_STATE_HOME for the MCP child. The conservative hook
loading/child-env defaults and busy follow-up default await KM-151 verification.
Latency stays unmeasured instead of inventing a number.

```text
running_tui_loads_new_hooks: no
resume_and_trust_required: yes
hook_session_id_equals_thread_id: yes
mcp_meta_threadId_present: yes
mcp_env_has_CODEX_THREAD_ID: no
mcp_env_has_XDG_STATE_HOME_when_shell_sets_it: no
queue_while_busy: follow_up_turn
idle_wake_latency_ms: unmeasured (deferred to KM-151 live acceptance)
required_user_setup: Resume the TUI, trust spike hooks through the normal review dialog, and set XDG_STATE_HOME and HOME explicitly in [mcp_servers.khala].env.
```

`hook_session_id_equals_thread_id` is an integration default; the existing evidence
correlates MCP metadata to the thread but does not separately record the hook ID.
`queue_while_busy` is the Executor's expected behavior; the native boundary document
does not contain a busy queue measurement. The exact numeric latency contract is
deferred with the manual legs, as directed by the Executor.
