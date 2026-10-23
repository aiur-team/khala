---
title: "feat: mute listening mode; async wakes on direct pings"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
depth: lightweight
---

# feat: `mute` listening mode; `async` wakes on direct pings

## Problem
`async` delivers nothing and wakes on nothing, mentions included (`harness/deliver-core.ts` and every waker skip it). The operator wants:
- **async**: no frames, no wakes for ordinary traffic; a direct ping (@AgentName, @agents, @channel) gets the constant, content-free nudge, and the agent reads via `khala_read`.
- **mute** (new, lowest rung): nothing delivered, nothing wakes, mentions ignored. `khala_read` still works.

## Key decisions
- **One policy point.** `wakesAgent(entry, mode, you)` in `events/receive.ts` decides: mute never; async only for a mention (`entry.mention` or `mentions()` from #1300/#1314); sync and steer unchanged. Wakers stop skipping async and skip only mute.
- **Archived / delegated read as `mute`** (`readListeningMode`), so they stay fully quiet now that async can wake.
- **Nudge watermark, not the backlog cursor.** Async never advances `deliveredCount` (the backlog `keepBacklog` preserves). A new optional `cursor.nudgedCount` marks mentions that already earned their nudge; wakers count from `max(deliveredCount, nudgedCount)`. Without it, Claude's Stop watcher would re-wake forever on the same unread mention. `advanceCursor` drops it, so it never outlives the backlog.
- **Hook nudge.** On prompt and Stop, `channelFrames` emits a constant line for async channels with an un-nudged mention ("call khala_read") and advances `nudgedCount`. Never content. Stop re-opens the turn the same way a sync frame does.
- **Quiet set.** Leaving async *or* mute for sync/steer skips the backlog unless `keepBacklog` (#1333 behaviour kept).
- **Attention order** steer > sync > async > mute; `self` may lower to mute, never raise from it.
- **Async-only harnesses** may also choose mute.
- **Old clients.** Hosted Matrix member state already degrades (unknown → default). Old agents ignore an undecodable owner command. The local helper serves strict decoders that reject unknown literals and retry forever, so it rewrites `mute` → `async` in member views unless the client sends `mute=1` (new opt-in param; old helpers ignore it). Frozen compat decoders pin the three released modes.

## Units
### U1. Contracts and mode set
Files: `packages/contracts/src/delivery/listening-mode.ts` (+test), `packages/contracts/src/m1/local.ts`, `packages/agent/src/compat/*.frozen.ts`, `packages/agent/src/mode.ts` (+test).
Tests: decode `mute`; `ATTENTION` order; leaving mute skips backlog; self-lower to mute allowed and self-raise from mute refused (`mcp/tools.test.ts` or `client-impl.test.ts`).

### U2. Wake policy and nudge
Files: `events/receive.ts`, `inbox.ts`, `harness/deliver-core.ts` (+test), `wake/ladder.ts`, `wake/opencode.ts`, `watch.ts`, `hooks/claude-wake.ts`, `client-impl.ts`.
Tests: async + direct mention → one nudge, then none; async + ordinary traffic → none; mute + mention → none; cursor `deliveredCount` unchanged.

### U3. Local wire compat
Files: `local/wire.ts`, `local/routes/rooms.ts`, `local/routes/owner.ts`, `local/session.ts`, `local/cli.ts`, web `composition/local/*`, `compat/wire-compat.test.ts`.
Tests: a mute member change stays decodable by frozen decoders; `mute=1` returns `mute`.

### U4. UI and docs
Files: web mode picker (`AgentPresencePanel.tsx` + test), AGENTS.md, SKILL.md, `docs/settings.md`, `install/muse-skill.ts`, `agent-instructions.test.ts`.
Tests: picker offers mute per agent.

## Out of scope
Netlify deploy (held: credits). Upgrading already-installed old CLIs/helpers.
