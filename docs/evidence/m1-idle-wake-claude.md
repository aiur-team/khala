# KM-111: Claude idle wake evidence

Status: **prototype validated; live evidence pending**. Updated 2026-10-02T05:05Z.
Unit tests do not establish interactive idle wake, plugin reload, or session-id
agreement. KM-146 must wait for the live decisions below.

## Versions and tested bytes

- Worker: Claude Code `2.1.287`; Node `v24.18.0`.
- Prototype commit: `5afe6e9f4745a4a00f526b793b9fbb0af8aa1147`.
- Checkout: `/home/everdred/.aiur/workspaces/aiur-team/khala/834`.
- SPIKE: `/home/everdred/.aiur/workspaces/aiur-team/khala/834/experiments/m1-idle-wake/claude`.
- Integration base: `main`.

## Setup actually needed

No plugin was installed and no shared spike state was created by this worker.
The Step 8 worker preflight failed on both required paths with
`[Errno 30] Read-only file system`:

- Creating `/home/everdred/.local/state/khala/claude/.km111-worker-write-probe`.
- Opening `/home/everdred/github/everdred/khala/AGENT-MESSAGES.md` for an empty append.

The Executor must run the stub inbox and log commands and coordinate the pane.
Do not substitute workspace-local state for the pane's default state: that would
test a different environment. Do not install before confirming pane serialization
with KM-112/KM-151 and monitor readiness.

## Local validation

All completed before live testing:

| Check | Result |
| --- | --- |
| `node --test experiments/m1-idle-wake/claude/hook.test.mjs` | 8 passed, 0 failed |
| `claude plugin validate experiments/m1-idle-wake/claude/marketplace` | Passed, no warnings |
| `claude plugin validate --strict experiments/m1-idle-wake/claude/marketplace/plugins/khala-wake-spike` | Passed, no warnings |
| `git diff --check` | Passed |

Tests cover inert sessions/missing inboxes, exact C6 delivery and deduplication,
non-message cursor advancement, Stop recursion, busy suppression, idle wake exit
2, unchanged watcher cursor, supersession, expiry, attribution of adversarial
text, file modes, invalid ids, and MCP handshake/probe logging. These run in
temporary state directories and leave no pane installation behind.

## Manual legs

| Leg | Outcome | Hook timestamps | Pane reply time |
| --- | --- | --- | --- |
| L0 preflight | Pending Executor execution | None | None |
| L1 install/reload hooks | Pending L0 | None | None |
| L1b resume if needed | Pending L1 outcome | None | None |
| L1c MCP and ids | Pending installation | None | None |
| L2 10-minute idle, AE2 | Pending quiet window | None | None |
| L3 20-second tool, AE3 | Pending pane | None | None |
| L4 two entries 300 ms apart | Pending quiet window | None | None |
| L5 65-minute lifetime | Not run: shared state/message writes denied | None | None |
| L6 ids after clear | Not run: pane coordination writes denied | None | None |
| L7 teardown | Pending; this worker installed nothing | None | None |

## Executor handoff

First append the following request to the shared `AGENT-MESSAGES.md` when the
pane serialization lock is available. The worker cannot publish it itself.

```text
### 2026-10-02T05:05Z — From: KM-111 worker; To: Executor

Request leg L0; target: Claude test session.
KM-111 spike, leg L0. Do not use any Khala tool. Run these in Bash and reply with the outputs: `claude --version`, `echo "$CLAUDE_CODE_SESSION_ID"`, `pwd`. Also state whether your AGENT-MESSAGES monitor is armed. Reply under `### <ts> — From: Claude test session; To: Executor`.

Worker Step 8 failed: both the default state path and AGENT-MESSAGES.md are read-only. Please execute the stub-inbox and log commands for each manual leg, relay the pane responses and sanitized logs back to ticket 834, and guard quiet windows. Prototype SPIKE=/home/everdred/.aiur/workspaces/aiur-team/khala/834/experiments/m1-idle-wake/claude; tested commit 5afe6e9f4745a4a00f526b793b9fbb0af8aa1147.
```

Continue with the exact leg text and timing criteria in
`docs/build/m1/tickets/KM-111.md:195-247`. Logs use `event` for the hook event
and `action` for `watch-armed`, `wake`, `watch-superseded`, `watch-orphan-exit`,
and `watch-expired`. Record append receipt event ids and times, and reconcile
them against delivery ids/counts; never infer delivery from a pane claim alone.

## Gaps

- Linear access returned `missing_linear_api_token`; no Agent Workpad comment
  could be read or posted. The durable workpad below substitutes until restored.
- Interactive version/monitor/session identity has not been observed by L0.
- No AE2/AE3, reload, long-lifetime, or id-agreement claim is supported yet.
- Local self-review moved the prompt's busy write before inbox reading and added
  a final watcher ownership check. No independent review or full CI was run.
- No product config or package surface changed. Contract C5/C6 remains untouched.

## Agent Workpad

Plan: implement isolated plugin/stub/probe; verify locally; coordinate L0–L7;
replace pending decisions with observed outcomes; review and open ready PR after
CI. Code and local validation are complete; live legs and shipping remain open.

Handoff phase: work, waiting for Executor execution at the shared-pane gate.
No quiet window is currently claimed by this worker. No manual test command
was sent to a pane. Keep this ticket active until live outcomes and teardown
are recorded; do not hand it to human review as completed.

## Decisions for KM-146

**Pending values are intentionally outside the final yes/no schema. This block
is not an acceptance result and must not be consumed as product configuration.**

- `reload_plugins_loads_hooks: pending`
- `reload_plugins_loads_mcp: pending`
- `resume_keeps_session_id: untested`
- `rewake_fires_user_prompt_submit: pending`
- `ids_agree (hook session_id = Bash $CLAUDE_CODE_SESSION_ID = MCP env): pending`
- `recommended_watcher_deadline_seconds: pending (4200 if L5 passes, otherwise 3000)`
- `required_user_setup: pending live reload/resume evidence`
