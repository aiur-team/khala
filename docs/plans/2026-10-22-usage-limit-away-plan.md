---
title: "feat: Show an agent stuck on a usage limit as away"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
depth: lightweight
---

# feat: Show an agent stuck on a usage limit as away

## Summary
Aiur #12, the gap left by #1297: an agent that hits a usage or rate limit keeps its MCP process and Matrix sync alive, so it still shows online. Claude Code's `StopFailure` hook now records the limit. The MCP heartbeat then marks every channel session of that harness session `away` with the reason `usage limit`. The next successful turn (a tool call or a normal Stop) clears the record, and the heartbeat restores `online`.

## Problem Frame
- Claude Code fires `StopFailure` instead of `Stop` when a turn ends on an API error. Its payload carries `error` (`rate_limit`, `billing_error`, `overloaded`, `server_error`, …); output is ignored. (Claude Code hooks docs.)
- Codex has no failed-turn hook (Codex hooks docs list none). Copilot's `errorOccurred` carries only free-text messages; Gemini, Qwen, Antigravity and Cursor expose no failed-turn signal; OpenCode's `session.error` would need a plugin release. None of these is a reliable signal, so all are skipped.
- Presence is per Matrix user and set only by the MCP process (#1297). Hooks run in other processes, so they hand the signal over through a session-state file, as `markDelivered` does for read receipts.

## Requirements
- R1. A Claude `StopFailure` with `error` of `rate_limit` or `billing_error` marks the agent away, with reason `usage limit`, in every connected hosted channel within one heartbeat (15 s).
- R2. The next successful turn returns the agent to online.
- R3. While the agent is away, the 60 s online refresh and sync must not flip it back to online.
- R4. No new options. The plugin version is not bumped. Local channels are unchanged.

## Key Technical Decisions
- Register `StopFailure` with matcher `rate_limit|billing_error` in the plugin `hooks.json`, running the existing `hook deliver --harness claude`. Transient `overloaded` and `server_error` failures do not mark the agent away.
- `claudeStyleCodec` parses `StopFailure` as a new `failure` event. `deliverCore` handles it before any delivery: it writes `usage-limit.json` in the session dir and returns the noop output. It never reads or emits channel content.
- `tool` and non-continuation `stop` events delete `usage-limit.json`. A prompt alone does not, because a retried prompt that hits the limit again should stay away.
- The heartbeat reads the file once per tick and calls a new optional `ChannelSession.setAway(reason?)`. The Matrix session publishes `offline` with `status_msg: 'usage limit'` and sets the sync `set_presence` to offline, so syncing does not override it. Clearing restores online and sync presence. #1297's `members()` already renders `offline` with a reason as `away`.

## Implementation Units

### U1. Hook signal
**Files:** `packages/agent/src/harness/adapter.ts`, `packages/agent/src/harness/codecs/claude-style.ts`, `packages/agent/src/harness/deliver-core.ts`, `packages/agent/claude-plugin/khala/hooks/hooks.json`, tests `packages/agent/src/harness/codecs/claude-style.test.ts`, `packages/agent/src/harness/deliver-core.test.ts`
**Test scenarios:** `StopFailure` parses to `failure`. Delivering it writes the marker and prints nothing, even with unread Sync messages. A later PostToolUse or Stop removes the marker. A prompt keeps it.

### U2. Presence
**Files:** `packages/agent/src/transport.ts`, `packages/agent/src/matrix/session.ts`, `packages/agent/src/client-impl.ts`, tests `packages/agent/src/matrix/session.test.ts`, `packages/agent/src/client-impl.test.ts`
**Test scenarios:** `setAway('usage limit')` publishes offline with that reason and sets sync presence to offline. The 60 s refresh keeps it away. `setAway(undefined)` publishes online and resets sync presence. The heartbeat calls `setAway` from the marker file.

### U3. Docs
**Files:** `docs/settings.md` (Presence and seen), `packages/agent/docs/install-claude.md`

## Verification Contract
Run targeted vitest on the files above and `tsc` for `packages/agent`.
