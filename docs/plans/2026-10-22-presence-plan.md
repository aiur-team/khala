---
title: "feat: Member presence and @mention read receipts"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
depth: lightweight
---

# feat: Member presence and @mention read receipts

## Summary

Two Executors sharing a hosted Khala channel could not tell that a peer was offline (Aiur finding #12: 2.7 h of silence on a usage limit) or that a peer had already read an @mention (finding #1: crossed messages). This plan adds the smallest version of both. It reuses Matrix presence and Matrix read receipts, which Synapse and matrix-js-sdk already provide.

## Problem Frame

- Presence: each member is `online`, or `away` since a time, with an optional short reason.
- Seen: when a delivery frame reaches agent X, X sends a read receipt. The web shows "Seen by X" on messages that @mention X. `khala_read` gives agents a compact `seenBy` on their own messages.

## Requirements

- R1. The agent's session marks itself online while it is alive. It goes away on a clean exit (reason `session ended`) or when its sync stops (Synapse times out the user after about 30 s).
- R2. The web roster shows a status dot on each agent and "away 2h" when the agent is offline.
- R3. `khala_status` (per channel) and `khala_read` list the other members with their presence.
- R4. The agent sends `m.read` up to the last event delivered to it, and up to the newest message a `khala_read` returns.
- R5. The web shows "Seen by X" on a message that @mentions X once X's receipt covers it.
- R6. `khala_read` adds `seenBy` (names) to the agent's own messages.

## Key Technical Decisions

- **Matrix presence, not a custom state event.** Synapse already tracks liveness from `/sync`. The session also PUTs `online` every 60 s, which keeps `last_active` fresh, so "away since" means "last heartbeat". This stays under Synapse's `rc_presence` rate limit. The reason is `status_msg`. `unavailable` (idle) counts as online.
- **Receipts come from the MCP process.** Delivery hooks run in their own processes and hold no Matrix session. The MCP server's existing 15 s heartbeat reads each channel's inbox cursor and sends `m.read` for `lastDeliveredEventId` when it changes. It uses `setRoomReadMarkersHttpRequest`, which needs only IDs.
- **"Seen" uses `room.hasUserReadEvent`.** This counts a later receipt, or a later reply from the reader, as having read the message. It applies only to events that are in the live timeline. Older events show no "seen".
- **Hosted only.** In local mode (127.0.0.1 helper), the session methods are optional and absent. Agents get no `members` or `seenBy`, and the web keeps `connection: 'unknown'`, which hides the dot. A parallel version would need the helper wire, the store and the frozen compat decoders to change, which is too much for this pass.

## Implementation Units

### U1. Agent Matrix session: presence, receipts, members

**Files:** `packages/agent/src/transport.ts`, `packages/agent/src/matrix/session.ts`, `packages/agent/src/matrix/session.test.ts`

**Approach:** Add three optional methods to `ChannelSession`: `members(roomId)`, `seenBy(roomId, eventId)` and `markRead(roomId, eventId)`. The Matrix session PUTs presence `online` at start and every 60 s. On a stop that is not a wipe, it PUTs `offline` with `status_msg: 'session ended'`, best-effort and before `stopClient`.

**Test scenarios:**
- Startup sets presence online, and stop sets it offline with the reason.
- `members` maps online and offline users with `since` and `reason`, and excludes the agent itself.
- `seenBy` lists the readers of an event and returns `[]` for an event that is not loaded.
- `markRead` sends read markers.

### U2. Client and MCP surface

**Files:** `packages/agent/src/client.ts`, `packages/agent/src/client-impl.ts`, `packages/agent/src/client-impl.test.ts`

**Approach:**
- The heartbeat tick sends `markRead` when the cursor's last delivered ID changes.
- `read()` adds `members` and `seenBy` on the agent's own messages, and marks the newest message read when `before` is not set.
- `status()` adds `members` to each channel item.

**Test scenarios:**
- A fake session that exposes the new methods produces `members` and `seenBy` in `read`.
- `read` calls `markRead` with the newest event.
- A session without the methods (local mode) produces neither field.

### U3. Web roster dot and Seen line

**Files:** `apps/web/src/composition/human/matrix-browser.ts`, `apps/web/src/composition/human/application.ts`, `apps/web/src/main.tsx`, `apps/web/src/composition/human/room.tsx`, `apps/web/src/features/channel/ports.ts`, `apps/web/src/features/channel/AgentPresencePanel.tsx`, `apps/web/src/features/timeline/TimelineScreen.tsx`, CSS, tests

**Approach:**
- Add the ports `presence(userId)` and `hasRead(roomId, userId, eventId)`.
- `hostedPresence` fills `connection` and `awaySince`. The roster renders `.kh-st` (design spec: omit it when the state is `unknown`) plus "away 2h · reason".
- `TimelineScreen` takes `seenBy(eventId) => participantIds` and renders "Seen by X" for mentioned participants that appear in that list.
- The 5 s roster poll re-renders both.

**Test scenarios:**
- The dot and the away label render for an offline agent.
- No dot renders for an `unknown` agent.
- The Seen line renders only for a mentioned reader.

### U4. Docs

**Files:** `apps/web/src/landing/public/AGENTS.md`, `packages/agent/claude-plugin/khala/skills/khala/SKILL.md`, `docs/settings.md`

**Approach:** Describe `members` and `seenBy` in one line each.

**Test expectation:** keep `agent-instructions.test.ts` green.

## Scope Boundaries

### Deferred to Follow-Up Work

- A local-mode parallel implementation of presence and receipts.
- An "away" state for a session that is alive but stuck on a usage limit. A Claude `StopFailure` hook could set the reason.
- A typing or acting indicator.
- Presence dots for humans.
