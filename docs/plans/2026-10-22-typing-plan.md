---
title: "feat: typing indicators for humans and agents (web only)"
type: feat
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
issue: aiur-team/khala#1316
---

# feat: typing indicators for humans and agents (web only)

## Summary
The hosted web UI shows "Alice is typing…" above the composer for other channel members, humans and agents alike. Agents never see typing. Hosted only, like presence and "Seen by" (#1297, #1304).

## Requirements
- R1. The web composer sends Matrix `m.typing` while the draft is non-empty, and clears it on empty draft or send.
- R2. The web timeline renders the open room's typing members (excluding the viewer) as one line.
- R3. A hosted agent shows as typing after content reaches it (hook delivery or `khala_read`), until it sends, its turn ends, a 10 min cap, or the 30 s server timeout.
- R4. Typing never wakes, nudges, or appears in `khala_read`, `khala_status` or frames. A regression test pins it.
- R5. Local channels: nothing (the optional session method is absent there).

## Key Technical Decisions
- **Agent typing piggybacks on the read-receipt points.** The MCP process already sends `m.read` from the 15 s heartbeat (`markDelivered`) and from `khala_read`. A new receipt for new content is the "agent saw a message" signal. No new hook, file, or process.
- **Keep-alive uses `activity.json`.** Hooks already write busy/idle per turn. The heartbeat refreshes typing while busy and clears it once idle. A no-hook harness has the epoch default, so it is cleared on the next heartbeat.
- **Agents ignore typing by construction.** The agent session only listens to `RoomEvent.Timeline`; `m.typing` is ephemeral and never enters it. Test asserts no handler fires on a typing emission.
- **Web throttling lives in the composition port.** `setTyping(roomId, bool)` sends true at most every 20 s (30 s timeout) and false only after a true.

## Implementation Units

### U1. Web: send and render typing
**Files:** `apps/web/src/composition/human/matrix-browser.ts`, `apps/web/src/composition/human/application.ts`, `apps/web/src/composition/human/room.tsx`, `apps/web/src/main.tsx`, `apps/web/src/features/timeline/TimelineScreen.tsx`, `apps/web/src/ui/khala/thread.css`; tests `apps/web/src/composition/human/matrix-browser.test.ts`, `apps/web/src/features/timeline/TimelineScreen.test.tsx`.
**Approach:** Mirror `presence`/`hasRead`: optional ports passed from main through the application context to `TimelineScreen` as an optional `typing` prop (`subscribe(roomId, onNames)`, `set(roomId, typing)`). The line uses a new class, not the design's omitted `.kh-typing` bubble.
**Test scenarios:** subscribe reports other typing members of that room only, ignores other rooms, unsubscribes; setTyping throttles repeated true and skips a false with no prior true; TimelineScreen renders "A is typing…", "A and B are typing…", and nothing when empty.

### U2. Agent: set typing, never receive it
**Files:** `packages/agent/src/transport.ts`, `packages/agent/src/matrix/session.ts`, `packages/agent/src/client-impl.ts`; tests `packages/agent/src/matrix/session.test.ts`, `packages/agent/src/client-impl.test.ts`.
**Approach:** Optional `setTyping?(roomId, typing)` on `ChannelSession`, Matrix session calls `sendTyping` with a 30 s timeout. client-impl: start on a new receipt (heartbeat or `khala_read`), refresh or clear in the heartbeat from `activity.json` and the cap, clear on `send`.
**Test scenarios:** session forwards setTyping; a typing emission on the client delivers nothing to message handlers; client-impl sets typing after a delivered receipt, clears on send, clears when activity goes idle.

## Scope Boundaries
- No typing in local mode, no typing in agent tool output, no new settings.
- Agent typing can lag delivery by up to one 15 s heartbeat.

## Verification
Targeted vitest files above plus typecheck for `apps/web` and `packages/agent`. Agent changes ship with the next khala-cli npm release.
