---
title: "feat: Per-user channel archiving"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Per-user channel archiving

## Summary

A human can archive a channel from the channel index. Archived channels leave the index and are listed under Settings > Archived channels, where they can be opened or unarchived. Archiving silences the archiving human's own agents in that channel. When an archived channel has unread messages, a final "Archived channels" row with an unread dot appears at the bottom of the index. The row goes away again once no archived channel is unread.

## Problem Frame

The operator wants to put idle channels away without leaving them, and stop their agents spending turns on them. The state is per user and synced across that user's devices.

## Requirements

- R1. Swipe a row left (touch) to reveal Archive; on desktop, a hover/focus Archive button; keyboard reachable.
- R2. Archived channels are hidden from the index.
- R3. Settings menu item "Archived channels" opens `/archived`, listing archived channels (unread marked), each with Open and Unarchive.
- R4. Per-user, cross-device storage.
- R5. Archiving turns off wakes and frame delivery for the archiving user's own agents in that channel; unarchive restores. Agents gain no access. `khala_status` reports `archived`.
- R6. Archived channels stay archived on new messages. A bottom "Archived channels" index row with an unread dot shows only while some archived channel is unread. It scrolls with the list and opens `/archived`.
- R7. Local mode only if cheap.

## Key Technical Decisions

- **Storage: `com.khala.archived: true` in the user's own `m.room.member` content.** This follows the precedent of `com.khala.channel_colors` (`setOwnChannelColors`). The member event is per user, synced to every device, and atomic. It is also readable by agents as room state, so no separate command or account-data sync is needed. Rejected alternatives:
  - Room tag or account data: agents can't read it, so it would need a second command channel that can drift.
  - A new command event: not durable across agent rejoin.
  - Trade-off: other members can see that a user archived a channel (metadata only).
- **Agent trust rule:** an agent honours the flag only from its inviter's member event. Matrix enforces sender == state_key for own-membership updates. The flag can only make the agent quieter, never grant access.
- **Agent effect:** the agent mirrors the flag into `mode.json` as `archived`. `readListeningMode` returns `async` while archived. Every delivery path (wake ladder, deliver-core, watch, claude-wake, opencode) already treats `async` as "no wakes, no frames", so one choke point covers all of them. `applyListeningMode` keeps `archived` and compares the stored (raw) mode. `khala_status` reports the stored mode plus `archived: true`.
- **Unarchive does not advance the cursor.** Messages from the archived period stay unread for the agent, and frame size limits already bound the backlog.
- **Bottom row:** rendered by `ConversationList` after the visible rows, inside `.kh-convos`, so it scrolls with the list.
- **Swipe:** a CSS scroll-snap row (row button + Archive button), with no gesture JS. On `(hover:hover)` pointers, the Archive button becomes a hover/focus-visible overlay icon.
- **Hosted only.** The local helper has no member-content passthrough, so the archive port is omitted in local mode and its UI is hidden.

## Implementation Units

### U1. Contract helper
**Files:** `packages/contracts/src/m1/archive.ts`, `packages/contracts/src/m1/archive.test.ts`
**Approach:** Add `ARCHIVED_MEMBER_KEY` and `memberArchived(content)`, which is true only for literal `true`.
**Test scenarios:** true → archived; missing, `"true"` or `1` → not archived.

### U2. Agent: follow owner archive
**Files:** `packages/agent/src/transport.ts`, `packages/agent/src/matrix/session.ts`, `packages/agent/src/client-impl.ts`, `packages/agent/src/mode.ts`, `packages/agent/hooks/claude-wake.ts`, `packages/agent/src/client.ts`, plus tests `packages/agent/src/mode.test.ts`, `packages/agent/src/client-impl.test.ts`
**Approach:**
- The session exposes `ownerArchived(roomId)`, which reads the inviter's member content.
- The session exposes `onOwnerArchived(handler)`, fired on a member state event whose state_key is the inviter.
- client-impl writes `archived` into `mode.json` on join and on every change.
- `readListeningMode` returns `async` when archived.
- claude-wake's raw `.mode === 'async'` checks use `readListeningMode`.
- Status adds `archived`.
**Test scenarios:**
- Archived mode file → `readListeningMode` returns async.
- Unarchive → the stored mode is back.
- `applyListeningMode` keeps `archived`.
- Owner member event archived/unarchived toggles `mode.json` and the status flag.
- A non-inviter's member event is ignored.

### U3. Web data + port
**Files:** `apps/web/src/composition/human/matrix-browser.ts` (+ test), `apps/web/src/composition/human/application.ts`, `apps/web/src/main.tsx`, `apps/web/src/ui/conversation/ConversationList.tsx` (`archived?` on summary)
**Approach:**
- The projection sets `archived` from the viewer's own member content.
- `setArchived(roomId, archived)` mirrors `setOwnChannelColors`.
**Test scenarios:**
- Projection flags an archived room.
- `setArchived` round trip writes the key and keeps other member content.
- `setArchived` fails when the user is not joined.

### U4. Web UI
**Files:** `apps/web/src/ui/conversation/ConversationList.tsx` (+ test), `apps/web/src/ui/khala/list.css`, `apps/web/src/ui/khala/SettingsMenu.tsx`, `apps/web/src/composition/human/routes.ts` (+ test), `apps/web/src/composition/human/mount.tsx`, new `apps/web/src/composition/human/ArchivedChannelsRoute.tsx`
**Approach:**
- The list filters out archived rows, and gives each row an Archive button when `onArchive` is given.
- It shows the bottom row when some archived item is unread, and the header unread count excludes archived channels.
- New route `/archived` (`inThread` on phones) lists archived channels with Open and Unarchive.
- New Settings item "Archived channels".
**Test scenarios:**
- Archived rows are hidden.
- The bottom row appears for unread archived channels and is absent when all are read.
- Clicking the bottom row calls `onOpenArchived`.
- Archive button calls `onArchive(id)`.
- Route parse round trip for `/archived`.

## Scope Boundaries
- Local mode (helper) is not supported. Hosted only.
- An agent that joins an already-archived channel reads the flag on join (covered). Pre-existing agents running old CLI versions ignore the flag until they upgrade, so a khala-cli release is needed.
- No visual snapshot regeneration. Playwright runs are not part of this change.

## Verification Contract
Targeted vitest for the touched test files, plus typecheck of `@khala/contracts`, `@khala/agent` and `apps/web`.
