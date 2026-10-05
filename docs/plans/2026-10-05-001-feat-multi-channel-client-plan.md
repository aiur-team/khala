---
title: Multi-channel agent client and MCP routing
date: 2026-10-05
type: feat
execution: code
artifact_readiness: implementation-ready
---

# Multi-channel agent client and MCP routing

## Goal and scope

Ticket #1102 extends one agent process to up to 16 channels, without changing
the join wire protocol, frozen decoders, hooks or SKILL.md. Joining B preserves
A's live session and backlog. With one channel, existing unqualified calls and
top-level status fields remain compatible. With several, read/send/event require
a room ID or a case-insensitive channel name (optionally prefixed with `#`).

## Dependencies and sequencing

Consume #1101's `channelFiles`, `listChannels`, `migrateLegacy`, join-file helpers
and `resolveChannel`; do not duplicate their implementation. Await its explicit
validated readiness signal before integration. The referenced design branch
`plan/multi-channel` is not currently available remotely; the ticket's D2/D5
contract supplies the requirements. #1095 removal must end only the affected
channel. Multi-harness U3 rebases after this ticket.

## U1: Independent channel lifecycle

Files: `packages/agent/src/client-impl.ts`, `packages/agent/src/client.ts`,
`packages/agent/src/client-impl.test.ts`,
`packages/agent/src/client-impl.transport.test.ts`.

Replace the active singleton with a room-keyed channel map and a separate map
of pending link attempts. Serialize calls for the same link, while allowing
different links to connect concurrently. Serialize replacement of sessions for
the same room even when credentials arrive through different links. Reserve
capacity for pending joins so concurrent requests cannot exceed 16 channels;
release reservations on failure. Keep one root rejoin secret.

Move status, mode, append queue and event deduplication into each channel. Keep
root status aggregate writes serialized, with `disconnected`/`closed` after
close. Migrate before clearing stale per-channel credentials on initialization;
retain backlog/cursor/mode. Preserve room, inviter and agent checks before every
message or mode update. Ignore stale callbacks after replacement or leave.

Resolve operations against current channel entries, never retained credentials.
Leave aborts and drains the selected session and its writes before removing its
directory; other channels continue. Ended sessions retain their disconnected
status for inspection. Close cancels all pending joins and all channels.

Tests: A/B join and continued intake; independent names/unread/modes; unchanged
single-channel results; per-channel removal and session end; exact routing;
required/unknown/ambiguous selectors; same-link deduplication and different-link
concurrency; same-room replacement without duplicates; channel-limit races;
restart migration preserves backlog; root closed status; wrong-room messages and
wrong-room/wrong-agent mode commands cannot mutate either channel; late callbacks
and old credentials cannot revive a left channel.

## U2: MCP surface and identity isolation

Files: `packages/agent/src/mcp/tools.ts`, `packages/agent/src/mcp/tool.ts`,
`packages/agent/src/mcp/wiring.ts`, their colocated tests,
`packages/agent/src/local/routes/agent-join.test.ts`,
`apps/control/src/agent-join/human-routes.test.ts`, `docs/user-guide.md`,
`docs/integrations/aiur-channel-events.md`.

Add optional channel selectors to status/read/send/event and required selector
to new `khala_leave`. Forward resolver error channel lists in structuredContent
and text with `isError: true`. Strip `channel` before event payload decoding;
validate it independently. Clear stale `joins/` at factory startup. Forward all
new arguments through wiring; keep MCP main's root close check intact. Update
existing user-guide tool tables and event integration documentation.

Tests: schema/argument validation, selector forwarding, leave, structured errors
including available channels, event decoding with selector, and factory startup
cleanup. Exercise real local `agentJoinRoutes` with a shared session secret and
room-scoped fake membership: room B must mint a fresh member when only A has
the key. Confirm hosted identity inputs differ across rooms for the same secret.

## Verification and completion

Use the installed pnpm and repository Vitest configuration. Run focused client,
MCP, local join-route and hosted human-route tests, then affected package
typechecks and repository lint. Audit all colocated test roots and mock clients
for the changed signatures before push. Exercise MCP through the CLI, then run
the CI `validate` commands (typecheck, lint, test, browser checks and build) as
required by `.github/workflows/ci.yml`. Self-review the pushed diff, verify current
configured base ancestry, and hand the draft PR to CI. After delivered green CI,
mark ready for human review. No temporary helper stubs ship.

## Risks and deferred checks

Credential arrival is the first reliable room identity; replacement/capacity
decisions must be made at that boundary. Aggregate status must never hide a
connected channel behind another channel's failure. Storage deletion must wait
for queued writes. The root rejoin secret identifies the instance, not a room;
server membership lookup and hosted identity derivation must remain room-scoped.
Inspect #1101's actual exports and safe-directory deletion rules on integration.
