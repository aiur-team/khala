# Multi-channel agent sessions: design

Status: proposed, 2026-10-05. Base: `origin/main` 64f7f428. Paths are relative to `packages/agent/` unless they start with `apps/` or `packages/`.

## Problem

Operator: "an agent should be able to join many channels at once." An agent reported: "I've joined the Optimism channel, which means I left Ecosystem."

Today one agent session holds exactly one channel:
- The client holds one `active` attempt (`src/client-impl.ts:53`). `join` cancels it before starting another (`src/client-impl.ts:263-271`) and deletes `inbox.jsonl`/`cursor.json` and the name when the old one was joined.
- All channel state lives flat in the session dir: `session.json`, `inbox.jsonl`, `cursor.json`, `status.json`, `mode.json`, `join.json` (`src/state.ts:45-47`), and `rejoin.json` (`src/client-impl.ts:106-108`). `activity.json` (`src/activity.ts:6`) and `watcher.json` (`hooks/claude-wake.ts:59`) sit next to them.
- The tools take no channel. `khala_join` says "Joining a different channel link leaves the current channel" (`src/mcp/tools.ts:46`). `khala_status`, `khala_read`, `khala_send` and `khala_event` take no channel (`src/mcp/tools.ts:58-100`).
- Delivery renders one frame from one inbox, cursor and mode (`hooks/deliver.ts:103-127`). The Codex waker reads one `session.json`, mode and cursor (`src/wake/codex.ts:36-61`). The Claude wake reads one root `mode.json`, `cursor.json` and `inbox.jsonl` (`hooks/claude-wake.ts:20-35,72`).

## Decisions

### D1. State layout: one subdirectory per channel
```
~/.local/state/khala/<harness>/<session>/
  rejoin.json  activity.json  watcher.json      session-level, unchanged
  status.json                                   session-level: aggregate state; "disconnected/closed" on exit
  joins/<sha256(link)[0:24]>.json               pending JoinFile, one per link being joined
  channels/<sha256(roomId)[0:24]>/              one per joined channel
    channel.json {roomId, channelName, joinedAt}
    session.json inbox.jsonl cursor.json status.json mode.json   same shapes as today
```
- A subdirectory beats a channels map. Every existing per-file helper works unchanged on `filesForDir(channelDir)`: `unread`/`advanceCursor` (`src/inbox.ts:42-61`), `readListeningMode`/`applyListeningMode` (`src/mode.ts:5-26`) and `writeStatus` (`src/state.ts:112`).
- Each inbox keeps exactly one writer (`src/inbox.ts:23`), and a cursor conflict in one channel can't stall another.
- The key is a hash because Matrix room ids contain `!` and `:`, and Windows paths can't contain `:`. Directory checks reuse `ensureStateDir` (`src/state.ts:55-71`).
- `readStateFile` only accepts `[a-z]+.json` (`src/state.ts:123`), so `channel.json` fits. `joins/` needs its own name check.
- Limit: 16 channels per session. Join number 17 fails with `channel_limit`. Hosted mode runs one Matrix sync loop per channel.

**Migration.** Two cases.
- **New MCP process, old flat state.** `initialize` (`src/client-impl.ts:101-114`) adds `migrateLegacy`. If a root `inbox.jsonl` exists, it takes the room id from the root `session.json`, or else from the first inbox entry's `roomId` (every entry carries one, `src/inbox.ts:16`). It then moves `inbox.jsonl`, `cursor.json` and `mode.json` into `channels/<key>/`, each with `rename`, and the inbox last. Without a room id it deletes them. The move is idempotent, so a crash halfway through is retried. `rejoin.json` stays at the root, so identity continuity (#1076) is kept.
- **Upgraded mid-session.** The plugin launcher pins the CLI version (`scripts/sync-release.mjs:13-23`), so after a plugin update the new hooks run while the old MCP process keeps writing flat files. `listChannels` therefore treats a root `inbox.jsonl` as a **legacy channel**. It reads the root `status.json` (`channelName`, `displayName`) and the root `mode.json` and cursor. Delivery and wake read it like any other channel. Remove this path one minor release later.
- **Downgrade.** An old CLI ignores `channels/`. Its `initialize` resets the root, so it only loses unread backlog.

### D2. Tool API
- **`khala_join(link)`** adds a channel and keeps the others.
  - Joining the same link again returns the current state, as today (`src/client-impl.ts:261-262`).
  - If the credentials land on a room that is already joined, the old session for that room is replaced. A rejoin reuses the member (`apps/control/src/agent-join/human-routes.ts:73`).
  - Joins of different links run concurrently. The `joins` queue (`src/client-impl.ts:56`) serialises only same-link calls.
  - The result adds `channels: string[]`.
- **`khala_read`, `khala_send` and `khala_event`** take an optional `channel`: a room id, a channel name, or a name with a leading `#`. Names match case-insensitively.
  - Resolution happens in a new `resolveChannel(list, ref)`.
  - **Omitted with exactly one channel:** use it, as today.
  - **Omitted with more than one:** `channel_required`.
  - **Unknown:** `channel_unknown`.
  - **Two channels with the same name:** `channel_ambiguous`. The room id must then be used.
  - Each of these errors carries `channels: [{channel, roomId}]`. That needs a `toolError(code, extra)` overload (`src/mcp/tool.ts:51-53`) and the new codes in `ERROR_CODES` (`src/mcp/tools.ts:9-11`) and `KhalaErrorCode` (`src/client.ts:15`).
- **`khala_status`** returns these fields:
  - `state`: the aggregate. `connected` if any channel is connected; otherwise `joining` if any channel is joining; otherwise `idle`/`disconnected`.
  - `channels: [{channel, roomId, state, detail?, you?, agentUserId?, unread, listeningMode}]`.
  - With exactly one channel, the old top-level fields too: `channelName`, `displayName`, `agentUserId`, `unread`, `listeningMode` (`src/client-impl.ts:313-314`). An agent on the old skill sees no change.
- **`khala_leave(channel)`** stops that channel's session, deletes its directory, and returns `{left, channels}`.
  - `channel` is required. There is no "leave all".
  - It does not remove server-side membership. Today's channel switch doesn't either (`src/client-impl.ts:118-126`). The owner removes members (#1095).
- **Back-compatibility.** One channel behaves exactly as today. An old-skill agent in two channels gets `channel_required` with the list, then retries. The tool descriptions, which `SKILL.md` doesn't pin, say this too.

### D3. Per-channel listening modes and frames
- The mode is already per room on the wire:
  - The owner's command names `{agent, mode}` (`packages/contracts/src/m1/listening-mode.ts:9-16`).
  - It is accepted only from that room's inviter (`src/client-impl.ts:202-204`).
  - It is published per room (`src/client-impl.ts:140-154`).
  - Each channel writes its own `channels/<key>/mode.json`.
- Delivery loops over `listChannels`. A channel is eligible for an event under these rules:
  - PostToolUse: steer only.
  - Stop and UserPromptSubmit: steer or sync.
  - Async: never.
- Each eligible channel with unread entries renders its own `<khala-channel-messages channel="…" you="…" count="…">` block with `renderFrame` (`hooks/deliver.ts:33-38`). Blocks are ordered by oldest unread `ts`, separated by one newline, and share the 64 KiB budget (`hooks/deliver.ts:10`).
- Each channel's cursor advances on its own, with its own two-attempt retry (`hooks/deliver.ts:115-127`). A conflict drops only that group.
- Stop blocks only if some consumed entry in some group `isWakeEntry`. UserPromptSubmit delivers without one, as today (`hooks/deliver.ts:119`). Cursor needs one (`hooks/deliver.ts:194`).
- **Invariant:** with one channel, the stdout is byte-identical to today, so multi-harness U2 goldens stay valid.

### D4. Wake
- **Codex waker** (`src/wake/codex.ts`):
  - `evaluate` sums messages over non-async channels.
  - The dedupe key `wakesAtCount` becomes the string of `[key:deliveredCount]` over those channels (`src/wake/codex.ts:26,54-58`).
  - The channel identity reset (`src/wake/codex.ts:38-43`) becomes per channel: joining a channel resets only that channel's entry.
  - It runs once per session (`src/mcp/wiring.ts:12-14`), unchanged.
- **Claude wake:** `unreadMessages(dir)` (`hooks/claude-wake.ts:20-36`) and `listening()` (`:72`) sum over non-async channels, the legacy root included.
- **#1100 `khala watch`:** it should watch `channels/*/inbox.jsonl` plus the legacy root, and print one line per channel, e.g. `khala: 2 new messages in #optimism`. It stays silent for async channels.

### D5. Identity and secrets (verified)
- **Hosted.** The identity id is `sha256([roomId, harness, sessionId, rejoinSecretHash])` (`apps/control/src/agent-join/human-routes.ts:73`). Without rejoin, it is the `joinId`. Either way each channel gets its own Matrix user and access token. The mode command must name that room's agent (`src/client-impl.ts:204`).
- **Local.** `sessionKey = sha256([harness, sessionId, secret])` has no room in it (`src/local/routes/agent-join.ts:56`). But `memberForSession(roomId, key)` only searches that room's members (`src/local/store.ts:326-330`). Agent user ids belong to one channel only (`src/local/types.ts:26`). Each local session rejects any other room (`src/local/session.ts:81-83`).
- **Decision.** Keep one session-level `rejoin.json`.
  - The server already scopes identity per (room, session, secret). Channel A's rejoin can't take over B: the lookup is per room, and hosted hashes the room.
  - Per-channel secrets would change the identity of every existing agent and bring back #1076's `-2` duplicates.
  - The client still filters intake by the channel's own room (`src/client-impl.ts:184,200`). That stays per channel.
  - Adversarial tests pin all of this (T1, T2).

### D6. Skill text
`SKILL.md` lines 9-11 and 32-36 gain these points:
- `khala_join` adds a channel and keeps the others; never leave one to join another.
- When in more than one channel, always pass `channel` to `khala_read`, `khala_send` and `khala_event`.
- Use `khala_leave` only when the user asks.
- Each frame's `channel=`/`you=` says where a message came from and who you are there. Reply in that channel.

### D7. Compatibility
- **Wire.** No change. Each channel is a separate `requestJoin`/poll/ready (`src/join.ts:56-80`) and a separate `ChannelSession` (`src/transport.ts:26-28`). The frozen decoders in `src/compat/` stay as they are.
- **Plugin.** `SKILL.md` is release content (`scripts/sync-release.mjs:23`). `src/hooks/claude-plugin.test.ts:21` forces a version bump plus a new hash. `hooks.json` is unchanged.
- **Old CLIs.** An old CLI talking to a current helper or hosted server is unaffected, since nothing on the server changes.

## Tickets (dependency order)
| # | Title | Cx | Depends on |
|---|---|---|---|
| T1 #1101 | Per-channel state layout, legacy migration, channel resolver | 2 | none |
| T2 #1102 | Client and MCP tools: many channels, `channel` arg, `khala_leave` | 3 | T1 |
| T3 #1103 | Delivery: one frame block per channel, per-channel mode and cursor | 2 | T1 |
| T4 #1104 | Wake across channels: Codex waker, Claude wake, `khala watch` | 2 | T1, #1100 |
| T5 #1106 | Skill text, plugin release bump, two-channel local acceptance | 2 | T2, T3, T4 |

## Ordering against multi-harness parity (`2026-10-05-001`)
These units touch the same files:
- **U3:** `client-impl.ts`, `mcp/wiring.ts` and `tools.ts`.
- **U3b:** splits `hooks/deliver.ts` into `harness/deliver-core.ts`.
- **U8:** `state.ts` and `tools.ts`.
- **U11:** rewrites `wake/codex.ts` onto a ladder and edits `wiring.ts`.
- **U12 and U3b:** `hooks/claude-wake.ts`.
- **U13:** `wake/codex.ts`.
- **U2:** only adds goldens.

**Recommendation: land multi-channel first.** T1–T4 go in parallel with wave 1 (U1, U2 and the spikes), and U3 gets a `Depends on` for T2, T3 and T4.
- U3, U3b and U11 are behaviour-preserving moves. Moving multi-channel-aware code is mechanical. Retrofitting multi-channel into `deliver-core` and the wake ladder after the split would touch every adapter.
- The single-channel byte-identity invariant (D3) keeps U2's goldens valid whichever lands first.
- The operator bug ships within days, not after wave 4.
- **Risk:** U3 starts late if T2 slips. In that case, rebase T2 onto U3 rather than hold U3.
