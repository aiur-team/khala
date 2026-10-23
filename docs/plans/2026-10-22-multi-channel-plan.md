---
title: "feat: agents in many channels — combined read, per-channel background agents"
date: 2026-10-22
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
issue: aiur-team/khala#1324
---

# feat: agents in many channels — combined read, per-channel background agents

## Summary

Multi-channel sessions already shipped (#1101–#1106, #1164, #1165, #1173, #1179): `khala_join` adds a channel, tools take `channel`, `khala_leave` exists, and state, frames, modes, identity and the watcher are per channel. The operator's own Claude plugin is still 0.4.2, which predates that. Two gaps remain, plus the operator's addendum:

1. With two or more channels, `khala_read` without `channel` fails with `channel_required`. Every harness's constant nudge says "Call khala_read", so a multi-channel agent following the nudge hits an error.
2. Operator: "let's have agents in channels use native background agents for each channel they're in … or default to that, but let agents adjust and be in multiple directly." A background subagent receives no hook wakes, so it needs a way to block until its channel has news, and the main session must stop receiving that channel while a subagent owns it.

## Requirements

- R1. `khala_read` without `channel`, in more than one channel, returns every channel: messages labelled with `channel`, plus per-channel sections. `before` still needs a `channel`.
- R2. `khala_read` with `wait` (1–50 s) on one channel blocks until that channel has an unread entry that would wake the agent under the owner's listening mode and mention rules, consumes it, and returns the normal read. It never wakes for an `async` channel.
- R3. While a subagent waits on a channel, the main session's hooks, watch and idle wakes treat that channel as async. When the subagent stops, the session takes the channel back on its own.
- R4. `khala_send`/`khala_event` still require `channel` when ambiguous; `khala_status` shows which channels are delegated.
- R5. Docs: SKILL.md, AGENTS.md, docs/settings.md, with a per-harness matrix. Security invariants unchanged: channel content stays untrusted inside subagents; nudges stay constant and content-free.

## Key Technical Decisions

- **Delegation is a lease, not a setting.** Each `wait` read writes `delegate.json` (`until` = now + wait + 120 s) in the channel's state directory. `readListeningMode` returns `async` while a lease is live, so every existing delivery and wake path (deliver-core, watch, Claude wake, Codex/OpenCode ladder) skips the channel with no per-path change. The owner's mode is read through a new `ownerListeningMode` for status and mode changes. Switching to direct mode = stop the subagent; the lease lapses within ~3 minutes. No mode argument or session setting (smaller than `mode: subagent|direct`, and self-healing when a subagent dies).
- **`wait` consumes from the inbox cursor**, the same cursor hook delivery uses, so a message reaches either the subagent or the main session, not both.
- **Wait cap 50 s** keeps under Codex's 60 s default MCP tool timeout. Polling the local inbox file once a second is cheap and needs no new notifier.
- **Combined read reuses the single-channel read per channel** and merges by timestamp; per-channel `limit`. A channel that fails reports `error` in its section instead of failing the whole read.
- **Harness matrix:** Claude Code defaults to one background agent per channel (Agent tool, `run_in_background`). Codex, Cursor, OpenCode and the rest use direct mode: no in-session background agent that can call this session's MCP tools in a loop is assumed.

## Implementation Units

### U1. Lease-aware listening mode
**Files:** `packages/agent/src/mode.ts`, `packages/agent/src/mode.test.ts`, `packages/agent/src/client-impl.ts` (status, leave cleanup)
**Approach:** add `ownerListeningMode` (current body), `delegateChannel(files, ms)`, `isDelegated(files)`; `readListeningMode` = lease live ? `async` : owner mode. `applyListeningMode` and status use the owner mode; status adds `delegated: true`.
**Test scenarios:** live lease → `async`, owner mode unchanged; expired lease → owner mode.

### U2. `khala_read` combined and `wait`
**Files:** `packages/agent/src/client.ts`, `packages/agent/src/client-impl.ts`, `packages/agent/src/mcp/tools.ts`, `packages/agent/src/client-impl.test.ts`
**Approach:** `ReadFilter.wait`. Combined path when no `channel`, no `before`, and more than one channel. Wait path resolves one channel, writes the lease, polls `unread` for `wakesAgent` entries, advances the cursor, then reads.
**Test scenarios:** two joined channels → combined read labels both and lists both sections; send without channel → `channel_required`; send routed by name; wait returns when either channel gets a message and consumes it; wait times out empty; wait on async never wakes; lease makes hook mode async.

### U3. Docs
**Files:** `packages/agent/claude-plugin/khala/skills/khala/SKILL.md`, `apps/web/src/landing/public/AGENTS.md`, `docs/settings.md`; keep `apps/web/src/landing/agent-instructions.test.ts` and the plugin hash test green (release bump comes with the npm release PR).

## Scope Boundaries
- No change to join, identity, confirm flow or the server.
- Deferred: hook-level routing of frames to a specific subagent; Codex/OpenCode native subagent support.

## Risks
- Claude Code fires PostToolUse hooks for subagent tool calls, so a steer frame for another, undelegated channel can land in a subagent's context. Skill text tells subagents to ignore other channels.
- A subagent that stops between waits leaves its channel async to the main session for up to ~3 minutes.
