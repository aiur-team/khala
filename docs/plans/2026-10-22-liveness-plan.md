---
title: "feat: Agent liveness (greyed when not running) and listening-mode indicator"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: https://github.com/aiur-team/khala/issues/1341
---

# feat: Agent liveness and listening-mode indicator

## Summary

Humans should see at a glance whether a channel agent is running, away (usage limit) or not running, and which listening mode it is in. Hosted Matrix presence already carries everything needed: the agent heartbeats `online` every 60 s, sets `offline` / `session ended` on a clean exit, `offline` / `usage limit` when away (#1307), and Synapse times a dead sync out to `offline`. This change surfaces that state in the web UI and closes the one clean-exit gap (SIGHUP).

## Problem Frame

Today only the roster dot and an `away 3m (session ended)` caption change. Chips and message avatars don't, a usage-limit away looks like a dead process, and closing the terminal window (SIGHUP) skips the MCP server's clean offline, leaving it to Synapse's ~30–60 s timeout.

## Requirements

- R1. Not-running agents are greyed in the roster, the mention chips and their message avatars, with a tooltip "Not running — last seen 3m ago". They un-grey on the next presence update that says online.
- R2. Away (offline with a reason other than `session ended`) reads "Away — usage limit · 3m" and is not greyed.
- R3. A closed terminal window (SIGHUP) sets presence offline at once, as SIGTERM does.
- R4. Each agent's chip shows its listening-mode icon (steer, sync, async, mute) with an accessible label and tooltip; it updates live with member state, including `khala_set_mode`. The roster already shows it.
- R5. No new polling or Netlify function calls.

## Key Technical Decisions

- **Reuse Synapse's sync timeout as the TTL.** The 60 s heartbeat plus Synapse's ~30 s sync timeout already catches SIGKILL within ~1 min. A client-side staleness check on `last_active_ago` would false-grey, because Synapse doesn't push `last_active` refreshes for currently-active users.
- **Classify from presence alone.** `connected` → running; `offline` + reason ≠ `session ended` → away; other `offline` → not running; unknown → no change. Known limit: an agent hard-killed while away keeps showing away.
- **Move the mode copy and `ModeIcon` to `ui/khala`** so `MentionChips` (ui layer) can use them without importing from features.
- **Local mode is out of scope.** The local helper has no presence.

## Implementation Units

### U1. SIGHUP clean exit

**Goal:** R3. **Files:** `packages/agent/src/mcp/main.ts`, `packages/agent/src/mcp/main.test.ts`.
**Approach:** register `onSignal` for SIGHUP next to SIGTERM/SIGINT, and remove it the same way.
**Test scenarios:** the existing "exits on SIGTERM" spawn test runs for SIGTERM and SIGHUP, and both exit 0 after cleanup. Clean exit → `offline`/`session ended` is already covered in `matrix/session.test.ts`.

### U2. Liveness helper and roster

**Goal:** R1, R2. **Files:** `apps/web/src/features/channel/AgentPresencePanel.tsx`, `apps/web/src/ui/khala/Avatar.tsx`, CSS in `apps/web/src/ui/khala/`, `apps/web/src/features/channel/ChannelScreen.test.tsx`.
**Approach:** replace `awayLabel` with a liveness helper returning `{ state, text }`. The roster row gets `kh-off` plus a `title` when not running. The Avatar status gains `away`, and the agent avatar gains an optional `offline` tooltip that greys it.
**Test scenarios:** an offline row with "session ended" or no reason is greyed and reads "Not running — last seen 2h ago"; an offline row with "usage limit" reads "Away — usage limit · 2h" and is not greyed; a connected row is not greyed (un-grey); an unknown row has no dot or grey; minutes, hours and days labels.

### U3. Chips and message avatars

**Goal:** R1, R4. **Files:** `apps/web/src/ui/khala/ModeIcon.tsx` (new, moved code), `apps/web/src/ui/khala/MentionChips.tsx`, `apps/web/src/features/timeline/TimelineScreen.tsx`, `apps/web/src/composition/human/room.tsx`, and tests next to MentionChips and TimelineScreen.
**Approach:** `MentionTarget` gains optional `mode` and `offline`. TimelineScreen takes an optional `agentState(participantId)` returning `{ mode, offline }`, which room.tsx builds from the controller snapshot and `modeFor`. It feeds both chips and the agent avatar.
**Test scenarios:** a chip renders the right icon and aria-label for each of the four modes; a chip with `offline` has `kh-off` and the tooltip; a timeline agent avatar is greyed when `agentState` says offline and not otherwise.

### U4. Docs

**Files:** `docs/settings.md` (Presence and seen). Describe greyed / away / mode icon and the SIGHUP behaviour. No change to the agent tool surface, so AGENTS.md and SKILL.md stay as they are.

## Verification Contract

Targeted vitest runs for the touched test files, plus web and agent typecheck. Then an npm patch release mirroring #1340, because packages/agent changed.
