---
title: "feat: iOS-style long-press Reply and inline reply threads"
type: feat
date: 2026-10-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: https://github.com/aiur-team/khala/issues/1321
---

# feat: iOS-style long-press Reply and inline reply threads

## Summary
Holding a message opens an iOS-style focus layer with a **Reply / Copy** menu. Reply mode shows the chain above the composer. Sent replies are standard Matrix rich replies and render inline, with a quote, a connector and an "N Replies" count. Research: `docs/research/2026-10-23-ios-reply-threads.md`.

## Problem Frame
Khala has no way to answer a specific message. The operator asked for iOS Messages parity: long-press opens Reply, and the reply chain stays in the main flow.

## Requirements
- R1. A hold of about 500 ms (touch or pointer), a right-click, or Enter / the context-menu key / Shift+F10 on a focused bubble opens a menu with Reply and Copy. A short tap, a drag or a scroll does not.
- R2. On touch devices, holding a bubble triggers no text selection and no iOS callout.
- R3. Reply mode shows the whole chain above the composer over a blurred timeline. Esc, the close button or tapping the blur cancels it.
- R4. A sent reply carries `m.relates_to.m.in_reply_to.event_id`, hosted and local.
- R5. Replies render inline, with a quote of the parent and a connector. The parent shows "N Replies". Tapping either opens the thread view.
- R6. A received legacy `> ` fallback is stripped from the body.
- R7. `khala_read` shows `↪ reply to <author>: <snippet>`.

## Key Technical Decisions
- **`m.in_reply_to`, not `m.thread`.** Threads are hidden from the main timeline in other clients, which breaks the "stays in flow" requirement.
- **`inReplyTo` lives on `TextMessageContent`.** It then flows through `ChannelPort.send`, the substrate and the decoders with no new port parameters. The digest encoding appends it only when it is present, so existing digests do not change.
- **One focus layer** serves the menu, reply mode and the thread view. This mirrors iOS, where every mode looks the same: the bubble or chain over a blur.
- **Agent context is formatted at read time.** A WeakMap tags each inbox entry with its parent ID, and `read()` rewrites the body using parents found in the same page. `InboxEntry` stays a strict contract with no new field.
- No fallback is sent (Matrix v1.13 / MSC2781).

## Implementation Units

### U1. Contract and wire
**Files:** `packages/contracts/src/messaging/events.ts`, `packages/contracts/src/messaging/events.test.ts`, `apps/web/src/composition/human/message-wire.ts`, `apps/web/src/composition/human/message-wire.test.ts`
**Approach:** Add an optional `inReplyTo` to text content. The reader accepts the key and validates it as an `EventId`. The digest appends it when present. Wire encode writes `m.relates_to`; wire decode reads it and strips the fallback.
**Test scenarios:** the digest of content without `inReplyTo` is unchanged; a reply's digest differs from the plain message's; encode emits `m.in_reply_to`; decode round-trips it; a legacy fallback is stripped; a body that is only a quote is kept; a malformed relation is ignored.

### U2. Thread model
**Files:** `apps/web/src/features/timeline/replies.ts`, `apps/web/src/features/timeline/replies.test.ts`
**Approach:** Pure helpers: the parent map, reply counts, and the chain for an event (root plus all descendants, in timeline order).
**Test scenarios:** chain of reply-to-reply; parent not loaded; counts; a cycle does not hang.

### U3. UI
**Files:** `apps/web/src/features/timeline/TimelineScreen.tsx`, `apps/web/src/ui/conversation/ChatMessage.tsx`, `apps/web/src/features/timeline/timeline.css`, `apps/web/src/features/timeline/TimelineScreen.test.tsx`
**Approach:** Add a long-press hook on the bubble. Add the focus layer: a menu (`role=menu`), or the chain plus a cancel control above the composer. Add an inline quote and connector to reply rows. `handleSend` attaches `inReplyTo`. Coarse pointers get `user-select: none` and `-webkit-touch-callout: none`. Reduced motion turns off the lift.
**Test scenarios:** a 500 ms hold opens the menu, while a release before that or a move does not; Reply shows the chain and the send carries `inReplyTo`; Esc cancels; a reply row renders its quote and the parent renders "1 Reply".

### U4. Agent read context
**Files:** `packages/agent/src/sender.ts`, `packages/agent/src/client-impl.ts`, plus a sender test.
**Test scenarios:** a parent in the same page gives the author and snippet; a missing parent gives "an earlier message"; a non-reply is unchanged.

## Scope Boundaries
- Out of scope: swipe-to-reply, tapbacks, edit, undo-send, and a reply-to argument for `khala_send`.

## Risks
- The server sees reply relations, as metadata only. The body stays encrypted.
- Long-press competes with scrolling. It is cancelled after a 10 px move or on scroll.
