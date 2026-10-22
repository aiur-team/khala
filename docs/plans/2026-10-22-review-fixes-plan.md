---
title: "fix: Review findings on #1294-#1301"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
depth: lightweight
---

# fix: Review findings on #1294-#1301

## Summary
Fix the P1/P2 findings from the single-reviewer pass on #1294-#1301, one PR per group, plus the cheap P3s. #1299's admission semantics are out of scope (operator decision).

## Problem Frame
- **P1 (#1300):** Claude's Stop frame moved from `decision:block` to Stop `hookSpecificOutput.additionalContext`, verified live only on Claude Code 2.1.307. The cursor advances before stdout is written, so a Claude that ignores the new shape loses the batch silently. The fake conformance driver was changed to accept the new shape, so it proves nothing.
- **P2 (#1297 x #1295):** `m.read` follows `cursor.lastDeliveredEventId`, which also advances for nudge-only deliveries (Cursor Stop). "Seen by" then shows for content the agent never saw.
- **P2 (#1298):** a 503 from `/api/agent/join/ready` (server-side invite failed) ends the join; nothing retries.
- **P2 (#1296):** every `khala_read` and claim folds up to 5 x 100 events of history.

## Key Technical Decisions
- **KTD1. Gate Claude Stop additionalContext on the running Claude version, read from the transcript.** The Stop payload carries `transcript_path`, and every Claude transcript line carries `"version"`. Reading the tail is the same cheap bounded read `claudeTranscriptInterrupted` already does, and it names the exact running binary (unlike `claude --version` on PATH, and the hook env carries no version). Version >= 2.1.307 renders additionalContext; anything lower, or unknown, renders `decision:block`, whose delivery is documented. A hook cannot learn that output was shown, so "known shown" means "a documented or live-verified contract for this version". No cache: the tail read is one bounded `read`.
- **KTD2. The codec stays data-only.** `DeliverCodec` gets an optional `stopContextFloor` and `render` an optional third argument; `claudeCodec` becomes `{ ...claudeStyleCodec, stopContextFloor }`. The other agent's codec edits merge cleanly.
- **KTD3. The receipt has its own cursor field.** `Cursor.shownEventId` advances only when the rendered output depends on the frame (detected by rendering two different frames and comparing, so no codec needs a new flag). `markDelivered` reads `shownEventId`. `khala_read` keeps its own receipt.
- **KTD4. Retry `ready` in the agent CLI.** `reportReady` retries 429 and 503 `unavailable` with backoff (1 s doubling to 15 s) inside a deadline equal to the invite timeout (120 s). This is smaller than server-side retry and also covers gateway 429s. The server route already leaves the join `claimed` on a failed invite, so a retry is idempotent.
- **KTD5. Fold only on request, incrementally cached.** `khala_read` folds when `include: ["state"]` or `kinds` is set. The fold caches its coordination events and the newest entry id in `fold.json` in the channel state dir; the next fold pages back only until it meets that id (else falls back to a full fold). Claims use the same fold.

## Implementation Units

### U1. Claude Stop version gate (PR 1)
**Files:** `packages/agent/src/harness/claude-transcript.ts`, `packages/agent/src/harness/codecs/claude-style.ts`, `packages/agent/src/harness/adapter.ts`, `packages/agent/src/harness/deliver-core.ts`, `packages/agent/src/harness/conformance/driver.ts`, tests `claude-transcript.test.ts`, `codecs/claude-style.test.ts`, `hooks/deliver.test.ts` goldens, `docs/settings.md`.
**Approach:** add `claudeTranscriptVersion(path)`; deliver-core computes the flag for Stop when the codec has a floor; revert the driver's Stop-additionalContext acceptance so conformance (no transcript, so unknown version) requires `decision:block`.
**Test scenarios:** transcript 2.1.307 renders additionalContext with `hookEventName: 'Stop'`; 2.1.306, missing transcript, and garbage render `decision:block`; Codex unchanged; conformance fails if the codec emits additionalContext for an unknown version.

### U2. Receipts only for shown content (PR 2)
**Files:** `packages/agent/src/inbox.ts`, `packages/agent/src/harness/deliver-core.ts`, `packages/agent/src/client-impl.ts`, tests in `inbox.test.ts` / `deliver-core.test.ts` / `client-impl.test.ts`, goldens that print the cursor.
**Test scenarios:** Cursor Stop nudge advances the cursor but leaves `shownEventId` unset; Cursor tool context and Claude Stop set it; `markDelivered` sends nothing after a nudge-only delivery.

### U3. Ready retry (PR 3)
**Files:** `packages/agent/src/join.ts`, `packages/agent/src/client-impl.ts`, `packages/agent/src/join.test.ts`.
**Test scenarios:** 503 `unavailable` then 204 resolves after one sleep; 429 then 204 resolves; 503 past the deadline fails `unavailable`; 404/409 never retry.

### U4. Cheap khala_read (PR 4)
**Files:** `packages/agent/src/client-impl.ts`, `packages/agent/src/client.ts`, `packages/agent/src/mcp/tools.ts`, `apps/web/src/landing/public/AGENTS.md`, `packages/agent/claude-plugin/khala/skills/khala/SKILL.md`, `docs/settings.md`, tests in `client-impl.test.ts` / `mcp` tests.
**Test scenarios:** plain read makes exactly one `history` call and returns no state; `include: ["state"]` returns folded state; a second fold with no new events reads one page and reuses `fold.json`; a missing cached id falls back to a full fold.

### U5. Cheap P3s (PR 5)
Clear every pending `__Host-khala_login-*` cookie (and the legacy unsuffixed one) on a successful sign-in (P3 #7). Test in the callback tests.

## Scope Boundaries
- Not changed: #1299 admission (operator decides).
- Deferred: P3 #6 (Cursor nudge count; touches the Cursor codec another agent is editing), P3 #8 (accepted trade-off), P3 #9 (documented convention).
