---
title: "feat: Structured coordination events on khala_event"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
depth: lightweight
---

# feat: Structured coordination events on khala_event

## Summary

Two Aiur Executors coordinated in a Khala channel with free text and grep (Khala findings #3, #4, #8, #9, #10, #11). This plan adds one generic mechanism: typed `khala_event` kinds with small validated `data` payloads. A bounded history fold derives coordination state from those events.

## Problem Frame

Agents need handoffs with an explicit ack, review verdicts, claims, channel notes, and filtered reads. Building five separate features would contradict the "very basic chat app" rule. Channel content is E2EE, so the server cannot enforce claims.

## Requirements

- R1. Add typed kinds `handoff`, `handoff_ack`, `verdict`, `claim`, `release` and `note`, each with a small validated `data` schema.
- R2. Render typed events compactly in the web timeline and the hook frames, with no new UI components.
- R3. Add `kinds?: string[]` and `mentionsOnly?: boolean` to `khala_read`.
- R4. Make `khala_read` return `openHandoffs`, `activeClaims` and `notes`, folded from room history.
- R5. Resolve claim conflicts deterministically on the client: the earliest claim by room order wins. A later `claim` call on an active key returns `{ error: "claimed", by, at }`.
- R6. Keep events non-waking, except that a handoff addressed to the agent counts as a mention.
- R7. Make local mode work through the existing generic event pipeline.
- R8. Document the kinds and filters in AGENTS.md, SKILL.md and docs/settings.md.

## Key Technical Decisions

- **Optional `data` on `com.khala.event.v1`.** We keep the same event type and version. Old decoders ignore the unknown field and still show `summary`. `data` is allowed only on the six typed kinds, and each kind validates its own fields.
- **Summary derived from data at encode time.** `encodeChannelEvent` fills `summary` from `data` when the caller omits it, truncated to 200 code points. The web pill, hook frames and older clients therefore render the event with no new UI. A `verdict` sets `status` (success for approved, attention for changes requested) when the caller omits it.
- **No `key` dedupe for typed kinds.** The existing key filter would drop a re-claim of the same key, so typed kinds keep the caller's `key` semantics unchanged and the fold uses event ids.
- **Fold over a bounded history scan.** The fold pages back up to 5 pages of 100 events, which covers most channels in one request. Older events are invisible to the fold. This is a documented limit (`ponytail:`).
- **Claims are a convention, not a lock.** `sendChannelEvent` for a `claim` folds first and returns `claimed` if another sender holds the key. After posting, it folds again and returns `claimed` if an earlier claim won. Only the holder can release a claim.
- **Handoff wake.** An inbox entry gains optional `eventKind`, `data` and `mention`. `mention` is set when the handoff's `data.to` names the agent. `isWakeEntry` and the watcher treat `mention` entries as wakes.

## Implementation Units

### U1. Contract: typed data schemas and derived summary
**Files:** `packages/contracts/src/m1/channel-event.ts`, `packages/contracts/src/m1/channel-event.test.ts`
**Approach:** Add `COORDINATION_KINDS` and a `readData(kind, input)` validator. Add `data` to the decode and encode paths. Encode derives `summary` and `status` when they are absent. Add a `foldCoordination(events)` helper here, so web and agent code can share it.
**Test scenarios:** each kind encodes with a derived summary; bad data (missing field, bad verdict, `data` on an untyped kind) fails with a path; an oversized reason is rejected; the fold handles claim-then-claim (the first wins), release by the holder versus a non-holder, a handoff closed by an ack, and note set then cleared.

### U2. Agent: inbox entry fields, read filters, derived state, claim check, handoff wake
**Files:** `packages/agent/src/events/receive.ts`, `packages/agent/src/client.ts`, `packages/agent/src/client-impl.ts`, `packages/agent/src/watch.ts`, `packages/agent/src/mcp/tools.ts`, `packages/agent/src/mcp/tools.test.ts`, `packages/agent/src/events/receive.test.ts`
**Approach:** Extend `khala_read`'s schema and `client.read` with a filter argument. Scan history once, then use the scan for both the filtered messages and the fold. `khala_event` relays a `claimed` result as a tool error.
**Test scenarios:** `kinds: ['claim']` returns only claims; `mentionsOnly` returns the mention and the addressed handoff; the read result carries `activeClaims`; a second claim from a peer returns `claimed`; a handoff to you is a wake entry.

### U3. Docs
**Files:** `apps/web/src/landing/public/AGENTS.md`, `packages/agent/claude-plugin/khala/skills/khala/SKILL.md`, `docs/settings.md`
**Test expectation:** `apps/web/src/landing/agent-instructions.test.ts` stays green.

## Scope Boundaries

- No server-side lock. No new event type. No new web component.
- Deferred: active claims in the `khala_join` text. Join returns before the history is synced, so the claims are listed on the first `khala_read`.
