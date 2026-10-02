# KM-111: Claude idle wake evidence

Status: **prototype validated; live acceptance deferred to KM-151**.
Unit tests do not establish interactive idle wake, plugin reload, or session-id
agreement. KM-146 uses the Executor defaults below pending KM-151.

## Versions and tested bytes

- Worker: Claude Code `2.1.287`; Node `v24.18.0`.
- Prototype commit: `5afe6e9f4745a4a00f526b793b9fbb0af8aa1147`.
- Checkout: `/home/everdred/.aiur/workspaces/aiur-team/khala/834`.
- SPIKE: `/home/everdred/.aiur/workspaces/aiur-team/khala/834/experiments/m1-idle-wake/claude`.
- Integration base: `main`.

## Setup and scope decision

Acting on @its-everdred (CODEOWNER for all touched paths), issue comment
5945958617: all manual pane legs are deferred to KM-151 live acceptance.
No spike plugin was installed and no shared state was created. The earlier
read-only preflight is superseded by this scope decision; no further shared
state or AGENT-MESSAGES writes are required.

## Local validation

- `node --test experiments/m1-idle-wake/claude/hook.test.mjs`: 8 passed.
- `claude plugin validate experiments/m1-idle-wake/claude/marketplace`: passed.
- `claude plugin validate --strict experiments/m1-idle-wake/claude/marketplace/plugins/khala-wake-spike`: passed.
- `git diff --check`: passed.

Tests exercise inert sessions, exact C6 delivery, deduplication, Stop recursion,
busy suppression, watcher ownership/expiry, unchanged watcher cursor, file modes,
untrusted attributed text, invalid ids, and MCP handshake/probe logging.
They establish prototype behavior only, not interactive harness behavior.

## Manual legs

| Leg | Outcome | Hook timestamps | Pane reply time |
| --- | --- | --- | --- |
| L0 preflight | deferred to KM-151 live acceptance | None | None |
| L1 install/reload hooks | deferred to KM-151 live acceptance | None | None |
| L1b resume | deferred to KM-151 live acceptance | None | None |
| L1c MCP and ids | deferred to KM-151 live acceptance | None | None |
| L2 10-minute idle, AE2 | deferred to KM-151 live acceptance | None | None |
| L3 20-second tool, AE3 | deferred to KM-151 live acceptance | None | None |
| L4 two entries 300 ms apart | deferred to KM-151 live acceptance | None | None |
| L5 65-minute lifetime | deferred to KM-151 live acceptance | None | None |
| L6 ids after clear | deferred to KM-151 live acceptance | None | None |
| L7 teardown | deferred to KM-151 live acceptance | None | None |

## Gaps

Interactive idle wake, reload, lifetime, and session-id agreement on 2.1.287
remain untested. Earlier 2.1.282 evidence of UserPromptSubmit on a wake turn is
in `experiments/interactive-cli/claude/live-proof.md`; it is not a 2.1.287 result.
No product package/config or contract changes are included.

## Agent Workpad

Prototype and local validation complete. Manual execution is deferred by the
Executor scope decision above. Shipping targets `main`. No plugin or spike state
requires cleanup. The earlier request for Executor pane execution is superseded.

## Decisions for KM-146

These are Executor-specified defaults, not live observations:

- `reload_plugins_loads_hooks: untested`
- `reload_plugins_loads_mcp: untested`
- `resume_keeps_session_id: untested`
- `rewake_fires_user_prompt_submit: untested`
- `ids_agree (hook session_id = Bash $CLAUDE_CODE_SESSION_ID = MCP env): untested`
- `recommended_watcher_deadline_seconds: 3000`
- `required_user_setup: install the plugin at user scope, then restart the session with claude --resume <id>`
