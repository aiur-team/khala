# Internal mode build — shared contracts (authoritative)

Every ticket in the `aiur-team/khala:internal-mode` build order quotes the shapes below verbatim. A ticket that needs a different shape stops and asks the Executor; it never invents a second version. Code is TypeScript (Node ≥ 22.23.2, ESM, run through `tsx`). Researched at `origin/main` `5ad41c8b` (2026-10-02). Plan: [`docs/plans/2026-10-02-001-feat-internal-mode-plan.md`](../../plans/2026-10-02-001-feat-internal-mode-plan.md). plan_version 1, amended by [`reconciliation.md`](reconciliation.md) R1–R18 (marked ✎ there; those rulings win over any text below).

Names in this file are **pinned**: a consumer may start against a pinned name before its producer merges, and plan-versus-landed name drift is a review-blocking defect, not a scheduling edge.

## L1. Package map and file ownership

No new package, no new runtime dependency, no database, no SQLite. All helper and agent code lives in `@khala/agent` (`packages/agent`), all shared wire types in `@khala/contracts` under the existing `./m1/*` export wildcard (`packages/contracts/package.json:7`), and all browser code in `@khala/web` (`apps/web`).

| File | Owner ticket | Purpose |
|---|---|---|
| `packages/contracts/src/m1/local.ts` (+ `.test.ts`) | KI-110 | L3–L7 wire and record types, constants, decoders, id helpers |
| `packages/contracts/src/m1/agent-join.ts` (edit) | KI-110 | `AgentCredentials.transport?`, `AgentJoinCreated.autoConfirmed?` (L4) |
| `packages/agent/src/local/types.ts` | KI-110 | Helper-internal interfaces: `LocalStore`, `LocalRequest`, `LocalResponse`, `LocalRoute`, `HelperContext` (L8) |
| `packages/agent/src/transport.ts` | KI-120 | `ChannelSession`, `StartSession`, `startChannelSession` (L9) |
| `packages/agent/src/local/session.ts` | KI-121 | `createLocalSession` (L9) |
| `packages/agent/src/local/identity.ts` | KI-122 | `resolveLocalOwnerName`, `saveHostedUsername` (L10) |
| `packages/agent/src/local/store.ts` | KI-130 | `openLocalStore` implementing `LocalStore` (L2, L3, L8) |
| `packages/agent/src/local/http.ts` | KI-131 | `createHelperServer` — node:http, guards, router, static web app (L6, L11) |
| `packages/agent/src/local/routes/agent-join.ts` | KI-132 | `agentJoinRoutes` (L4) |
| `packages/agent/src/local/routes/rooms.ts` | KI-133 | `roomRoutes` (L5) |
| `packages/agent/src/local/routes/owner.ts` | KI-134 | `ownerRoutes`: channels, links, open, mode, agent rename, remove, shutdown (L6) |
| `packages/agent/src/local/routes/profile.ts` | KI-135 | `profileRoutes` (L6, L7) |
| `packages/agent/src/local/lifecycle.ts` | KI-136 | `ensureHelper`, `readHelperFile` (L11) |
| `packages/agent/src/local/cli.ts`, `packages/agent/src/local/serve.ts`, `packages/agent/bin/khala.mjs` (edit) | KI-137 | `khala local …` commands and helper composition (L12) |
| `apps/web/src/composition/local/{http,types,session,profile,agent-names}.ts` | KI-140 | Helper client, identity/device/participant, profile and rename ports (L13) |
| `apps/web/src/composition/local/{substrate,channel-service}.ts`, `apps/web/src/composition/human/message-wire.ts` | KI-141 | `LocalSubstrate` and the shared Matrix-content projection (L13) |
| `apps/web/src/composition/local/{conversations,members,links}.ts` | KI-142 | Channel list, members cache, listening modes, share links, admission stub (L13) |
| `apps/web/src/composition/local/ports.ts`, `apps/web/src/local-main.tsx`, `apps/web/local.html`, `apps/web/vite.local.config.mjs`, `apps/web/package.json` (scripts) | KI-143 | Local entry and `build:local` (L13) |
| `apps/web/src/composition/human/mount.tsx`, `room.tsx` (copy only), `screen.tsx` (copy only) | KI-144 | Local owner account mode (L13) |

## L2. On-disk layout (single writer: the helper)

`stateRoot` is the existing `stateRoot(env)` from `packages/agent/src/state.ts:22-26` (`$XDG_STATE_HOME/khala` when absolute, else `~/.local/state/khala`). Directories are created with the existing `ensureStateDir` (`state.ts:37-52`, 0700, rejects symlinks, group/other bits and foreign uids) — called only on `<stateRoot>/local/channels` and deeper, because it also checks two parent levels (R3); opening the store writes nothing until the server has bound its port (R4); every JSON file is written with the existing `writeJsonAtomic` (`state.ts:58-77`, 0600).

```text
<stateRoot>/
  hosted-profile.json                 0600  {"v":1,"username":"kevin","savedAt":"…"}   written by the agent on a hosted connect (KI-122); read-only for the helper
  local/                              0700
    helper.json                       0600  L11 HelperFile; written only by the running helper
    helper.log                        0600  helper stderr/stdout (no message bodies, no tokens)
    owner.json                        0600  L7 OwnerProfile
    channels/<roomKey>/               0700  roomKey = roomId without the leading "!" and the ":local" suffix
      log.jsonl                       0600  L3 LocalEvent, one per line, append-only
      harness.json                    0600  non-legacy harness ids by userId, rewritten atomically
      secrets.json                    0600  L3 ChannelSecrets (hashes only), rewritten atomically
```

- The helper is the **only** writer of everything under `local/`. Agents' MCP processes stay the only writers of their own session directories (`<stateRoot>/<harness>/<sessionId>/`, unchanged).
- On start the store replays `log.jsonl`; a torn last line (no trailing `\n` or invalid JSON) is ignored and truncated away before the next append, the same tolerance as `readEntries` (`packages/agent/src/inbox.ts:12-19`).
- Deleting a channel removes `channels/<roomKey>/` recursively. Nothing is pruned automatically (D6).

The helper keeps non-legacy harness ids in `harness.json` as `{ "<userId>": "<harnessId>" }` and omits them from member content in `log.jsonl`. Replay restores those ids for member views and channel summaries. Older helpers ignore the sidecar and keep reading every event and sequence number.

For `/events`, `/messages`, `/members`, and channel summaries, `harness` defaults to the legacy ids (`claude`, `codex`, `cursor`) only. Requests with `wire=2` receive other valid harness ids. `prev=1` independently includes preceding member content in `/events`; it never enables new ids. New local clients send `wire=2`, which older helpers ignore. Shared wire decoders remain closed until the decoder migration.

## L3. Ids, events and secrets (`packages/contracts/src/m1/local.ts`)

Local ids are Matrix-shaped so every existing decoder and the agent's `senderKindOf` (`packages/agent/src/sender.ts:7-10`) keep working: `readMatrixUserId` wants `^@[^\s:]+:\S+$`, `readRoomId` wants `^!\S+$` (`packages/contracts/src/m1/agent-join.ts:87-97`), and the inbox decoder wants `^\$\S+$` (`packages/contracts/src/m1/inbox.ts:20`).

```ts
export const LOCAL_SERVER_NAME = 'local' as const;
export const LOCAL_OWNER_USER_ID = '@khala_owner:local' as const;       // the one human; display name = OwnerProfile.username
export const LOCAL_DEFAULT_PORT = 47830;
export const LOCAL_LINK_TTL_MS = 600_000;                                // single-use share link and open link lifetime (D5)
export const LOCAL_LONG_POLL_MAX_S = 25;
export const LOCAL_IDLE_EXIT_MS = 600_000;                               // helper exits after 10 min with no request and no open long-poll (D2)
export const LOCAL_TOKEN_BYTES = 32;                                     // 43 base64url chars

export function base64url(bytes: Uint8Array): string;   // pure, no Buffer/btoa: this module runs in the browser too (R1)
export function hex(bytes: Uint8Array): string;
export const newLocalRoomId = (random16: Uint8Array): string => `!${base64url(random16)}:local`;   // 22 chars + suffix; RangeError unless 16 bytes
export const localRoomKey = (roomId: string): string => { if (!isLocalRoomId(roomId)) throw new RangeError('not_local_room'); return roomId.slice(1, -':local'.length); };
export const newLocalAgentUserId = (random4: Uint8Array): string => `@agent-${hex(random4)}:local`;
export const newLocalEventId = (random16: Uint8Array): string => `$${base64url(random16)}`;
export const localAgentDeviceId = (userId: string): string => `KH_LOCAL_${userId.slice(7, 15)}`;   // R5: derived, never stored (optional helper; tickets may inline the rule)
export const isLocalRoomId = (value: string): boolean => /^![A-Za-z0-9_-]{22}:local$/u.test(value);

export type LocalEventType = 'm.room.create' | 'm.room.name' | 'm.room.member' | 'm.room.message'
  | 'com.khala.event.v1' | 'com.khala.listening_mode.v1';

export type LocalEvent = {
  seq: number;                 // 1-based, strictly increasing per channel, assigned by the helper
  eventId: string;             // "$<22 base64url>"
  roomId: string;              // "!<22 base64url>:local"
  type: LocalEventType;
  sender: string;              // LOCAL_OWNER_USER_ID or "@agent-<8 hex>:local"
  ts: number;                  // helper clock, ms since epoch
  txnId?: string;              // present when the sender supplied one; (sender, txnId) is unique per channel
  content: Record<string, unknown>;
};

// content by type
export type LocalCreateContent = { name: string; createdBy: string; operationId?: string };                       // m.room.create (seq 1)
export type LocalNameContent = { name: string };                                            // m.room.name
export type LocalMemberContent = {                                                          // m.room.member
  user: string; membership: 'invite' | 'join' | 'leave';
  displayname: string; kind: 'human' | 'agent';
  harness?: 'claude' | 'codex'; invitedBy?: string;
  'com.khala.listening_mode'?: 'steer' | 'sync' | 'async';
};
// m.room.message content: { msgtype: 'm.text', body: string }                 (body 1..8000 chars, as khala_send)
// com.khala.event.v1 content: ChannelEventContent from '@khala/contracts/m1/channel-event' (encoded by encodeChannelEvent)
// com.khala.listening_mode.v1 content: ListeningModeCommandContent from '@khala/contracts/m1/listening-mode' ({v:1, agent, mode}); sender must be LOCAL_OWNER_USER_ID

export type ChannelSecrets = {
  v: 1;
  links: Record<string, { expiresAt: string; consumedAt?: string; kind: 'join' }>;           // key = sha256(token) hex
  members: Record<string, { tokenSha256: string }>;                                          // key = user id; the owner has no entry (cookie auth)
};

export function decodeLocalEvent(input: unknown): Decoded<LocalEvent>;     // strict: unknown keys fail
```

Worked `log.jsonl` (one channel, the operator's flow):

```jsonl
{"seq":1,"eventId":"$q3Zp0bE8yS1m4Vt7nC2aRw","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"m.room.create","sender":"@khala_owner:local","ts":1759395601000,"content":{"name":"refactor","createdBy":"@khala_owner:local"}}
{"seq":2,"eventId":"$a1…","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"m.room.member","sender":"@khala_owner:local","ts":1759395601001,"content":{"user":"@khala_owner:local","membership":"join","displayname":"kevin","kind":"human"}}
{"seq":3,"eventId":"$b2…","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"m.room.member","sender":"@khala_owner:local","ts":1759395630000,"content":{"user":"@agent-a1b2c3d4:local","membership":"invite","displayname":"kevin-Claude","kind":"agent","harness":"claude","invitedBy":"@khala_owner:local"}}
{"seq":4,"eventId":"$c3…","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"m.room.member","sender":"@agent-a1b2c3d4:local","ts":1759395632000,"content":{"user":"@agent-a1b2c3d4:local","membership":"join","displayname":"kevin-Claude","kind":"agent","harness":"claude","com.khala.listening_mode":"sync"}}
{"seq":5,"eventId":"$d4…","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"m.room.message","sender":"@khala_owner:local","ts":1759395700000,"txnId":"web-7b1e","content":{"msgtype":"m.text","body":"@kevin-Codex can you review PR #12?"}}
{"seq":6,"eventId":"$e5…","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"com.khala.listening_mode.v1","sender":"@khala_owner:local","ts":1759395800000,"content":{"v":1,"agent":"@agent-a1b2c3d4:local","mode":"steer"}}
{"seq":7,"eventId":"$f6…","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"m.room.member","sender":"@agent-a1b2c3d4:local","ts":1759395801000,"content":{"user":"@agent-a1b2c3d4:local","membership":"join","displayname":"kevin-Claude","kind":"agent","harness":"claude","com.khala.listening_mode":"steer"}}
```

Derived state (replay rules, owned by KI-130, consumed by everyone):
- Members = the last `m.room.member` per `content.user`. A member is **present** when its membership is `invite` or `join`.
- Display names come only from member events. A rename is a new member event with the same membership and a new `displayname`, sent by the owner.
- Listening mode of an agent = `content['com.khala.listening_mode']` of its last member event, else `sync` (`DEFAULT_LISTENING_MODE`, `packages/contracts/src/m1/listening-mode.ts:8`). The agent writes it (echo after applying an owner command), exactly like the Matrix member-state echo (`packages/agent/src/matrix/session.ts` `publishListeningMode`).
- Channel name = the last `m.room.name` content, else the create content.

## L4. Agent join (the hosted C2 wire contract, served by the helper)

The helper serves the **same three routes** as `apps/control` so `packages/agent/src/join.ts` (`requestJoin`, `pollJoin`, `reportReady`) is reused unchanged except for the two optional fields below. Exact paths; `joinId` only as a query parameter; errors `{ "error": <code> }`. See `docs/build/m1/contracts.md` C2 for the hosted original.

Two additive, optional fields in `packages/contracts/src/m1/agent-join.ts` (KI-110):

```ts
export type AgentJoinCreated = { joinId: string; pollSecret: string; confirmUrl: string; expiresAt: string; autoConfirmed?: true };
export type AgentCredentials = {
  homeserver: string; userId: string; accessToken: string; deviceId: string; roomId: string;
  transport?: 'matrix' | 'local';     // absent ⇒ 'matrix' (every hosted record stays valid)
};
```

Local behaviour:
- **Share link:** `http://127.0.0.1:<port>/join/<43-char base64url token>`. It passes the shipped `parseChannelLink` (`packages/agent/src/join.ts:5-13`) unchanged.
- `POST /api/agent/join {link, harness, label}` → `201 {joinId, pollSecret, confirmUrl: "<origin>/agent/confirm?joinId=<joinId>", expiresAt, autoConfirmed: true}`.
  - The link token is **consumed atomically here** (single use, D5): `secrets.links[sha256].consumedAt` is set before the response. Unknown, consumed or expired token → `404 {"error":"link_unavailable"}`. Malformed link → `400 invalid_link`.
  - Harness ids are validated with `isHarnessId`; registered ids use the registry model name and unknown valid ids use `Agent`.
  - The agent is named by the helper (the `label` is ignored, as hosted, `packages/agent/src/mcp/tools.ts:47`): `defaultLocalAgentName(owner.username, harness, n)` from `packages/agent/src/local/identity.ts`, using `harnessInfo(harness).modelName`, with the smallest `n ≥ 1` whose name is not a present member's display name in that channel (case-insensitive), validated with `checkName(name, 'agent')`.
  - The helper mints the agent's user id, access token and device id (`KH_LOCAL_<8 hex>`), appends the `invite` member event (`invitedBy: LOCAL_OWNER_USER_ID`), and marks the join `confirmed` immediately: the join is announced in the channel by that member event (D5). There is no confirm page and no click.
  - `joinId` = 16 random bytes base64url; `pollSecret` = 32 random bytes base64url, stored only as sha256 in memory. Pending joins live in memory; a helper restart turns a pending poll into `404` (`join_expired` on the agent), which is acceptable inside the 10-minute window.
- `GET /api/agent/join/poll?joinId=` (Bearer pollSecret) → first call `{state:'confirmed', credentials:{homeserver:<origin>, userId, accessToken, deviceId, roomId, transport:'local'}}`, later calls `{state:'claimed'}`; wrong secret or unknown join → `404 not_found`.
- `POST /api/agent/join/ready?joinId=` (Bearer) → `204`.

Agent-side change (KI-120): `requestJoin` passes `autoConfirmed` through when it is exactly `true`; `credentials()` (`join.ts:100-105`) preserves `transport` when it is exactly `'local'`; `KhalaAgentClient.join` waits up to 15 s for an auto-confirmed attempt to reach `connected` and then returns `{ state: 'connected', channelName }` (fallback: the existing `awaiting_confirmation` result, rendered as "Joining… call khala_status").

## L5. Participant room API (agents and the owner browser)

All routes are under the helper origin, JSON bodies, errors `{ "error": <code> }`. `:roomId` is `encodeURIComponent(roomId)`. Auth: **either** `Authorization: Bearer <accessToken>` (agent) **or** the owner cookie `khala_local_owner` (browser; mutations also need header `x-khala-local: 1`, L11). The owner is treated as the member `LOCAL_OWNER_USER_ID`.

```ts
// GET  /api/local/rooms/:roomId/me
export type LocalMe = { userId: string; roomId: string; roomName: string; membership: 'invite' | 'join' | 'leave'; invitedBy?: string; displayName: string };   // agents always get invitedBy, also after joining (R6)
// POST /api/local/rooms/:roomId/join                 body {} → LocalJoined   (invite → join; appends the join member event; idempotent when already joined)
export type LocalJoined = { seq: number; ts: number };   // seq of the caller's own join event = the live cutoff
// GET  /api/local/rooms/:roomId/events?after=<seq>&wait=<0..25>
export type LocalEventsPage = { events: LocalEvent[]; next: number };   // events with seq > after, ascending, at most 200; next = last seq returned or `after`
//   answers immediately when an event with seq > after exists, else holds up to `wait` seconds and answers {events:[], next:after}
// GET  /api/local/rooms/:roomId/messages?before=<eventId>&limit=<1..100>
export type LocalHistoryPage = { events: LocalEvent[]; nextBefore?: string };   // m.room.message + com.khala.event.v1 only, oldest first, strictly older than `before`; nextBefore = oldest eventId when older ones exist
// POST /api/local/rooms/:roomId/send
export type LocalSendRequest = { txnId: string; type: 'm.room.message' | 'com.khala.event.v1'; content: Record<string, unknown> };   // txnId 1..64 chars [A-Za-z0-9._-]
export type LocalSendResult = { eventId: string };   // replays the same eventId for a repeated (sender, txnId)
// GET  /api/local/rooms/:roomId/members
export type LocalMember = {
  userId: string;                    // "@khala_owner:local" | "@agent-<8hex>:local"; the web uses it as Participant.matrixUserId
  participantId: string;             // = userId (the web's ParticipantId)
  ownerId: typeof LOCAL_OWNER_ID;    // every member belongs to the one owner
  deviceId: string;                  // agents "KH_LOCAL_<8hex>", the owner LOCAL_OWNER_DEVICE_ID; the web's authorDeviceId
  displayName: string; kind: 'human' | 'agent'; harness?: 'claude' | 'codex';
  ownerLabel?: string;               // agents: the owner's username (Participant.ownerLabel)
  membership: 'invite' | 'join';
  listeningMode?: 'steer' | 'sync' | 'async';   // agents only; DEFAULT_LISTENING_MODE when never echoed
};
export type LocalMembersResponse = { members: LocalMember[] };   // present members only
export const LOCAL_OWNER_ID = 'local-owner' as const;             // the web's OwnerId / AuthPrincipal.ownerId
export const LOCAL_OWNER_DEVICE_ID = 'KH_LOCAL_OWNER' as const;
// PUT  /api/local/rooms/:roomId/members/:userId      body {listeningMode}  → 204   (caller must be :userId and an agent; appends a member event echoing the mode)
```

Errors: `401 unauthorized` (no or bad token/cookie), `403 not_member` (removed or never a member), `404 not_found` (unknown room), `400 invalid_request`, `413 payload_too_large` (body > 64 KiB), `409 conflict` (PUT for another user).

Event visibility: every member sees every event of the channel (events stream includes member, name and listening-mode events). Agents filter their own sender (`client-impl.ts:135`) and the live cutoff (seq ≤ own join seq is never delivered live).

Message content on the wire is the **Matrix content** the hosted clients already exchange, so every projection is shared:
- text: `{ "msgtype": "m.text", "body": "…" }` (agents' `khala_send`; the browser's `MessageContent {v:1, kind:'text'}`), as `sendRoomMessage` builds it (`apps/web/src/composition/human/matrix-browser.ts:504-512`);
- legacy rename notices: `{ "msgtype": "m.notice", "body", "com.khala.agent_participant_id", ["com.khala.name_snapshot", "com.khala.name_source_event_id"] }` (same lines) — accepted and stored, never generated by local code;
- channel events: `ChannelEventContent` (`packages/contracts/src/m1/channel-event.ts:13`).
The helper validates only: `msgtype ∈ {m.text, m.notice}`, `body` a string of 1..8000 characters, total content ≤ 32 KiB.

**Join and leave announcements (D5)** are channel events appended by the helper with sender `LOCAL_OWNER_USER_ID`, built with `encodeChannelEvent` from `packages/contracts/src/m1/channel-event.ts`:

```json
{"type":"com.khala.event.v1","content":{"v":1,"kind":"member","summary":"kevin-Codex joined","status":"info","source":{"system":"khala-local"},"body":"kevin-Codex joined"}}
```

They render with the existing channel-event pill in the web timeline (`SubstrateEvent` kind `channel_event`, `packages/messaging/src/channels/substrate.ts:47`) and reach agents as `kind:'event'` inbox entries, which never wake anyone (`packages/agent/src/events/receive.ts` `isWakeEntry`). The exact `body` string is whatever `encodeChannelEvent` produces for that input.

## L6. Owner API (browser and CLI)

Auth: owner cookie (browser; mutations need `x-khala-local: 1`) **or** `Authorization: Bearer <adminToken>` from `helper.json` (CLI). Never an agent token.

```ts
// GET    /api/local/channels?since=<revision>&wait=<0..25>    → LocalChannelsPage   newest activity first
//   answers immediately when `since` is absent or differs from the current revision; else holds up to `wait` s
export type LocalChannelsPage = { revision: number; channels: LocalChannelSummary[] };   // revision: helper-wide counter bumped on every append/create/delete (in memory; restarts at 0)
export type LocalChannelSummary = {
  roomId: string; name: string; createdAt: string; lastSeq: number; lastTs: number;
  preview: string | null;                                  // body of the latest m.room.message (m.text), else null
  lastSender?: { userId: string; displayName: string };    // sender of that message
  members: { userId: string; displayName: string; kind: 'human' | 'agent'; harness?: 'claude' | 'codex' }[];   // present members, owner first
};
// GET    /api/local/channels/:roomId                          → LocalChannelSummary | 404 not_found
// GET    /api/local/channels/by-operation/:operationId        → { roomId: string } | 404 not_found   (browser create reconciliation, ChannelSubstrate.findCreatedRoom)
// POST   /api/local/channels           body {name, operationId?} → LocalChannelCreated   (name 1..64 chars, trimmed; appends create + owner join; operationId 1..64 [A-Za-z0-9._-] is stored in the create content and is idempotent)
export type LocalChannelCreated = { roomId: string; name: string; selfLink: string; shareLink: string; openUrl: string; expiresAt: string };
//   selfLink: a single-use join link for the creating agent; shareLink: a second single-use join link for the human to paste into another agent chat;
//   openUrl: a single-use owner open link for the browser (below). All three expire after LOCAL_LINK_TTL_MS.
// DELETE /api/local/channels/:roomId                          → 204   (removes the channel directory; open long-polls end with 404)
// POST   /api/local/channels/:roomId/links                    → { shareLink: string; expiresAt: string }   a fresh single-use join link
// POST   /api/local/channels/:roomId/mode   body {agent, mode, txnId} → { eventId: string }   appends com.khala.listening_mode.v1 {v:1, agent, mode} from the owner (txnId dedup); 404 for a non-agent
// POST   /api/local/agents/:userId/name     body {name}        → AgentRenameResult {matrixUserId, name}   (`packages/contracts/src/m1/agent-names.ts:5-6`, same shape as hosted /api/human/agents/rename)
//          checkName(name,'agent') else 400 {"error":"invalid_name"}; unique (case-insensitive) among present members of that agent's channel else 409 {"error":"name_taken"}; appends a member event with the new displayname
// DELETE /api/local/channels/:roomId/members/:userId          → 204   appends a leave member event + a "<name> left" channel event; membership `leave` is the revocation and the token stays resolvable, so that agent's next call gets 403 not_member (R7)
// Any owner route called with an agent token → 401 {"error":"unauthorized"} (R8)
// GET    /api/local/profile                                   → OwnerProfileView   (also the browser's session check: 401 without the cookie)
// POST   /api/local/profile/username  body {username}         → { username }   400 {"error":"invalid_username","reason":NameError}; renames agents still on a default name (isDefaultAgentName) in every channel, like hosted renameDefaultAgents
// POST   /api/local/profile/color     body {color}            → { color }      400 {"error":"invalid_color"}
// POST   /api/local/profile/initials  body {initials|null}    → { initials }   follows the hosted initials contract once PR #986 merges; until then 1–2 letters [A-Za-z] or null
// POST   /api/local/open            body {roomId?}             → { openUrl: string; expiresAt: string }   (admin bearer only)
// GET    /open/<43-char token>                                → 302 to /channels/<encodeURIComponent(roomId)> or /conversations (R9); sets the owner cookie; single use
// GET    /join/<token>                                        → the web app (SPA); the token is NOT consumed by a browser GET
// GET    /healthz                                             → { ok: true, version: string, pid: number }   (no auth, no data)
// POST   /api/local/shutdown                                  → 204   (admin bearer only)
```

## L7. Local owner profile (D4, D8)

```ts
export type OwnerProfile = { v: 1; username: string; color: HumanColorId; initials: string | null; updatedAt: string };   // initials per R10   // <stateRoot>/local/owner.json
export type OwnerProfileView = { userId: typeof LOCAL_OWNER_USER_ID; ownerId: typeof LOCAL_OWNER_ID; username: string; suggestion: string; color: HumanColorId; initials: string | null };
// The web's ProfilePort.get() maps it to ProfileView {username, suggestion, color} (`packages/contracts/src/m1/profile.ts:7`); username is never null locally, so the first-run username gate never shows.
```

- First helper start with no `owner.json`: `username = resolveLocalOwnerName(env)` (L10); `color = defaultHumanColor(LOCAL_OWNER_USER_ID)` (`packages/contracts/src/m1/colors.ts:19-21`).
- `username` obeys `checkName(name,'username')` (`packages/contracts/src/m1/names.ts:18-26`). `initials` (when present) obeys the same rule as the hosted initials work in flight (PR #986); until that merges, 1–2 letters `[A-Za-z]`.
- Local identity is never fetched from or written to khala.aiur.team (D8).

## L8. Helper-internal interfaces (`packages/agent/src/local/types.ts`, KI-110)

Route modules and the server code against these types only, so KI-131..KI-134 start in parallel against fakes; KI-137 composes the real pieces.

```ts
import type { IncomingHttpHeaders } from 'node:http';
export type LocalRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; query: URLSearchParams; headers: IncomingHttpHeaders;
  body: unknown;                       // parsed JSON (undefined for GET/DELETE or empty body); invalid JSON is rejected by the server with 400 before routing
  auth: LocalAuth; origin: string;     // origin = "http://127.0.0.1:<port>" (the helper's canonical origin)
  signal: AbortSignal;                 // aborted when the client disconnects (long-poll)
};
export type LocalAuth =
  | { kind: 'none' }
  | { kind: 'owner'; via: 'cookie' | 'admin' }
  | { kind: 'agent'; userId: string; roomId: string };
export type LocalResponse =
  | { status: number; json?: unknown; headers?: Record<string, string> }
  | { status: 302; location: string; headers?: Record<string, string> };
export type LocalRoute = { method: LocalRequest['method']; pattern: RegExp; handle(req: LocalRequest, params: string[], ctx: HelperContext): Promise<LocalResponse> };

export interface LocalStore {
  listChannels(): LocalChannelSummary[];                                   // newest activity first
  channelSummary(roomId: string): LocalChannelSummary | undefined;
  createChannel(name: string, operationId?: string): Promise<{ roomId: string; created: boolean }>;   // same operationId → same roomId, created:false
  findByOperation(operationId: string): string | undefined;
  deleteChannel(roomId: string): Promise<void>;
  hasChannel(roomId: string): boolean;
  channelOfMember(userId: string): string | undefined;                     // agent user ids are unique across channels
  revision(): number;                                                      // bumped on every append/create/delete
  waitForRevision(since: number, timeoutMs: number, signal: AbortSignal): Promise<void>;   // resolves when revision() !== since, on timeout, or on abort
  append(roomId: string, input: { type: LocalEventType; sender: string; content: Record<string, unknown>; txnId?: string }): Promise<LocalEvent>;   // dedups (sender, txnId)
  eventsAfter(roomId: string, after: number, limit: number): LocalEvent[];
  waitForEvent(roomId: string, after: number, timeoutMs: number, signal: AbortSignal): Promise<void>;   // resolves when lastSeq > after, on timeout, or on abort
  history(roomId: string, before: string | undefined, limit: number): LocalHistoryPage;
  members(roomId: string): LocalMember[];
  member(roomId: string, userId: string): (Omit<LocalMember, 'membership'> & { membership: 'invite' | 'join' | 'leave' }) | undefined;   // R12
  channelName(roomId: string): string;
  mintLink(roomId: string, kind: 'join'): Promise<{ token: string; expiresAt: string }>;   // returns plaintext once; stores sha256
  consumeLink(token: string): Promise<{ roomId: string } | null>;                           // atomic single use; null if unknown/used/expired
  setMemberToken(roomId: string, userId: string, tokenSha256: string | null): Promise<void>;
  agentForToken(token: string): { roomId: string; userId: string } | null;                 // timing-safe compare over sha256
  owner(): OwnerProfile;
  setOwner(next: OwnerProfile): Promise<void>;
}
export type HelperContext = { store: LocalStore; origin: string; now(): number; random(bytes: number): Uint8Array; version: string;
  mintOpenToken(roomId?: string): { token: string; expiresAt: string }; consumeOpenToken(token: string): { roomId?: string } | null;   // in memory
  createOwnerSession(): string;   // R12: 43-char id accepted as the khala_local_owner cookie
  shutdown(): void;               // R12: exit 0 after the current response flushes
  joins: Map<string, PendingJoin> };
export type PendingJoin = { joinId: string; pollSecretSha256: string; roomId: string; credentials: AgentCredentials; state: 'confirmed' | 'claimed' | 'ready'; expiresAt: number };
```

## L9. Agent transport seam (`packages/agent/src/transport.ts`, KI-120)

`AgentMatrixSession` (`packages/agent/src/matrix/session.ts:9-23`) is already a transport interface. It is renamed in place, not redesigned:

```ts
export type { SessionMessage, SessionModeCommand } from './matrix/session';   // the type definitions move here; matrix/session.ts re-exports them
export interface ChannelSession {           // identical members to AgentMatrixSession today
  readonly userId: string;
  inviter(roomId: string): string | undefined;
  onListeningModeCommand(handler: (c: SessionModeCommand) => void): () => void;
  publishListeningMode(roomId: string, mode: ListeningMode, signal?: AbortSignal): Promise<void>;
  onMessage(handler: (m: SessionMessage) => void): () => void;
  waitForInvite(roomId: string, timeoutMs: number): Promise<void>;
  join(roomId: string): Promise<void>;
  history(roomId: string, limit: number, before?: string): Promise<{ messages: SessionMessage[]; nextBefore?: string }>;
  send(roomId: string, text: string): Promise<{ eventId: string }>;
  sendChannelEvent(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<{ eventId: string }>;
  roomName(roomId: string): string | undefined;
  displayName(userId: string): string | undefined;
  stop(): Promise<void>;
}
export type StartSession = (creds: AgentCredentials) => Promise<ChannelSession>;
export const startChannelSession: StartSession = async creds => creds.transport === 'local'
  ? (await import('./local/session')).createLocalSession(creds)
  : (await import('./matrix/session')).createAgentMatrixSession(creds);   // lazy: local mode never loads matrix-js-sdk
```

`createLocalSession(creds: AgentCredentials, opts?: { fetch?: typeof fetch; ensureHelper?: () => Promise<void>; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; log?: (line: string) => void }): Promise<ChannelSession>` (KI-121) maps each method onto L5 exactly as the table in the plan (§ Architecture). `inviter()` returns `LocalMe.invitedBy` captured in `join()`; mode commands arrive as `com.khala.listening_mode.v1` events in the stream; `publishListeningMode` is the `PUT …/members/:self`.

## L10. Local owner name (D8, `packages/agent/src/local/identity.ts`, KI-122)

```ts
export async function saveHostedUsername(username: string, env?: NodeJS.ProcessEnv): Promise<void>;   // writes <stateRoot>/hosted-profile.json {v:1, username, savedAt}
export async function resolveLocalOwnerName(env?: NodeJS.ProcessEnv): Promise<string>;
//   1. hosted-profile.json username, when checkName(username,'username') accepts it
//   2. env.USER (or os.userInfo().username), when checkName accepts it after trimming
//   3. LOCAL_OWNER_FALLBACK_NAME = 'User'   ('owner' is reserved, R11)
```

The hosted agent client calls `saveHostedUsername` once per hosted connect with the owner's username, derived from its own hosted display name by stripping the `-Claude`/`-Codex[-n]` suffix (`isDefaultAgentName`, `packages/contracts/src/m1/names.ts:33-36`); a renamed agent (no default suffix) saves nothing. Never a network call for this.

## L11. Helper process (`helper.json`, guards, lifecycle)

```ts
export type HelperFile = { v: 1; pid: number; port: number; origin: string; adminToken: string; version: string; startedAt: string };
```

- Binds `127.0.0.1` only, port `KHALA_LOCAL_PORT` or `LOCAL_DEFAULT_PORT` (47830). `EADDRINUSE`: if `GET /healthz` on that port answers `{ok:true}` the new process exits 0 (another helper owns it); otherwise it fails with `port_in_use` (no silent port move: links embed the port).
- **Host guard:** every request's `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; else `421 {"error":"misdirected"}` (DNS-rebinding defence). No CORS headers are ever sent.
- **Mutation guard:** non-GET requests authenticated by cookie must carry `x-khala-local: 1` and, when an `Origin` header is present, it must equal the helper origin; else `403 {"error":"forbidden_origin"}`. Bearer-authenticated requests (agents, CLI) skip the cookie checks.
- **Owner cookie:** `khala_local_owner=<43-char random>`; `HttpOnly; SameSite=Strict; Path=/`; no `Secure` (plain loopback). Session ids live in memory; a helper restart signs the browser out until `khala local open` mints a new open link. `/open/<token>` is the only way to obtain the cookie.
- **Idle exit (D2):** the helper exits 0 after `KHALA_LOCAL_IDLE_MS` (default `LOCAL_IDLE_EXIT_MS`) with no request and no open long-poll. It is never installed as a service.
- **Static web app:** `GET` of any non-`/api/`, non-`/open/`, non-`/healthz` path serves `apps/web/dist-local/` (env override `KHALA_LOCAL_WEB_DIR`), with SPA fallback to `index.html`; assets get `cache-control: no-cache`. A missing build answers `503 {"error":"web_not_built"}` and the CLI tells the user to run `pnpm --filter @khala/web build:local`.
- `ensureHelper(env)` (KI-136): read `helper.json`; `GET /healthz` with a 500 ms timeout; on success return `{ origin, adminToken }`; otherwise spawn `process.execPath <repo>/packages/agent/bin/khala.mjs local serve` detached (`stdio` to `helper.log`, `unref()`), then poll `/healthz` every 100 ms for up to 5 s; failure → `KhalaClientError('internal_error','helper_unavailable')`. Tokens never appear in argv or env (`/proc/*/cmdline` is world-readable). The child gets an allow-listed copy of the caller's env (`HOME`, `PATH`, `XDG_STATE_HOME`, `KHALA_LOCAL_*`, `NODE_OPTIONS`, …) so the no-egress guard follows it (R13).

## L12. CLI (`khala local …`, KI-137)

Every command prints exactly one JSON object on stdout and exits 0, or prints `{"error":<code>}` on stdout and exits 1. Commands that need the helper call `ensureHelper` first.

| Command | Output |
|---|---|
| `khala local create [name]` | `LocalChannelCreated` (L6). Default name `local-<yyyy-mm-dd>` |
| `khala local link <roomId\|name>` | `{ shareLink, expiresAt }` |
| `khala local open [roomId\|name]` | `{ openUrl, expiresAt }` (never launches a browser) |
| `khala local list` | `{ channels: LocalChannelSummary[] }` |
| `khala local delete <roomId\|name>` | `{ deleted: roomId }` |
| `khala local status` | `{ running: boolean, origin?, pid?, version?, channels?: number }` (does not start the helper) |
| `khala local stop` | `{ stopped: boolean }` |
| `khala local serve` | runs the helper in the foreground (used by `ensureHelper`; prints nothing on success) |

A name argument matches a channel by exact name; an ambiguous name → `{"error":"ambiguous_channel"}`. Other codes (R14): `invalid_arguments`, `not_found`, `helper_unavailable`, `unsafe_state_dir`, `storage_failed`, `port_in_use` (serve, stderr). Hints such as `web_not_built` go to stderr.

## L13. Web transport seam (KI-140..KI-145)

Full port inventory with line refs: [`research/web-seam.md`](research/web-seam.md). The seam is the existing `HumanApplicationPorts` (`apps/web/src/composition/human/application.ts:33-59`), consumed through `createHumanApplication` (`:116`). Only `apps/web/src/main.tsx` imports `matrix-browser.ts`/`browser-api.ts`; no screen does. The local build is a **second entry** that builds the same ports bundle from `apps/web/src/composition/local/*`. `main.tsx`, `features/*` and `ui/*` are not edited. Browser code may import `@khala/messaging` only under a `/composition/` path and may never import `packages/agent` (`scripts/check-boundaries.mjs:117,131`).

```ts
// apps/web/src/composition/local/http.ts (KI-140)
export type LocalHttpResult<T> = { kind: 'ok'; value: T } | { kind: 'error'; status: number; code: string } | { kind: 'unavailable' };
export interface LocalHttp {
  get<T>(path: string, decode: (v: unknown) => Decoded<T>, signal?: AbortSignal): Promise<LocalHttpResult<T>>;
  send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, decode: (v: unknown) => Decoded<T>, signal?: AbortSignal): Promise<LocalHttpResult<T>>;   // adds x-khala-local: 1
}
export function createLocalHttp(input: { origin: string; fetch?: typeof fetch; timeoutMs?: number }): LocalHttp;   // same-origin credentials; default timeout 10 s, long-poll callers pass their own signal

// apps/web/src/composition/local/session.ts (KI-140)
export const LOCAL_PRINCIPAL: AuthPrincipal;   // {v:1, ownerId: LOCAL_OWNER_ID, providerIssuer:'khala-local', providerSubject:'owner', verifiedEmail:'', sessionExpiresAt:'9999-12-31T23:59:59.000Z'}
export function createLocalSession(http: LocalHttp): Readonly<{
  identity: IdentityPort;        // current(): GET /api/local/profile → {kind:'signed_in', principal: LOCAL_PRINCIPAL} | {kind:'unavailable', retryable:true}; NEVER signed_out
  device: DevicePort;            // ensureReady → {deviceId: LOCAL_OWNER_DEVICE_ID, state:'ready', generation:1, reason:null}; generation never changes during a page life
  participant(): ParticipantView | null;   // the owner: {participantId: LOCAL_OWNER_USER_ID, kind:'human', ownerId: LOCAL_OWNER_ID, displayName: <username>, deviceIds:[LOCAL_OWNER_DEVICE_ID]}
}>;
// apps/web/src/composition/local/profile.ts, agent-names.ts (KI-140)
export function createLocalProfilePort(http: LocalHttp): ProfilePort;        // apps/web/src/features/profile/ports.ts
export function createLocalAgentNamesPort(http: LocalHttp): AgentNamesPort;  // apps/web/src/features/channel/ports.ts; POST /api/local/agents/:userId/name

// apps/web/src/composition/human/message-wire.ts (KI-141; extracted from matrix-browser.ts:466-504 and :506-526, no matrix-js-sdk import; unrelated to the contracts `encodeMessageContent`, R16)
export function encodeMessageContent(content: MessageContent): Record<string, unknown>;   // m.text / m.notice payload exactly as sendRoomMessage builds it
export function projectWireEvent(input: { type: string; content: Record<string, unknown>; eventId: EventId; participant: ParticipantView;
  authorDeviceId: DeviceId | null; clientTxnId: string | null; receivedAt: string }, limits: ContentLimits): SubstrateEvent | null;
// apps/web/src/composition/local/substrate.ts (KI-141)
export function createLocalSubstrate(input: { http: LocalHttp; limits: ContentLimits; members: LocalMembersCache; generation: () => number }): ChannelSubstrate;
// apps/web/src/composition/local/channel-service.ts (KI-141): createChannelService over the substrate, built after device ready (mirrors matrix-browser.ts:802-836)

// apps/web/src/composition/local/types.ts (KI-140) declares it; members.ts (KI-142) implements it as createLocalMembers(http, limits) (R16)
export interface LocalMembersCache {
  members(roomId: RoomId): readonly LocalMember[] | undefined;      // undefined until the first load
  describe(participantId: string): Participant | undefined;         // Participant from '@khala/contracts/m1/participants' with matrixUserId = userId
  subscribe(roomId: RoomId, listener: () => void): Disposer;        // fires on member/mode changes seen in the room long-poll
  refresh(roomId: RoomId): Promise<void>;
}
// apps/web/src/composition/local/conversations.ts, links.ts (KI-142)
export function createLocalConversations(http: LocalHttp): ConversationIndexPort & { dispose(): void };   // long-poll /api/local/channels; unread from a localStorage last-seen seq
export function createLocalChannelLinks(http: LocalHttp): HumanChannelLinks;   // personal(roomId) → POST /api/local/channels/:roomId/links → {v:1, kind:'personal_link', shareUrl, expiresAt}
export const localAdmission: AdmissionPort;                                    // share/admit → unavailable; inspect → 'unavailable'

// apps/web/src/composition/local/ports.ts (KI-143)
export function createLocalHumanPorts(input: { origin: string; limits: ContentLimits; fetch?: typeof fetch }): HumanApplicationPorts & { dispose(): void };
//   no agentJoin, no inviteAgent, no tabHandoff; listeningMode/subscribeListeningModes/setListeningMode from the members cache and POST …/mode

// apps/web/src/composition/human/mount.tsx (KI-144)
export type HumanAccountMode = 'oauth' | 'local_owner';
// HumanApplicationScreenProps and mountKhalaContent input gain `account?: HumanAccountMode` (default 'oauth').
// local_owner: no Log out item, no sign-in redirect; signed_out/unavailable identity renders one short panel naming `khala local open`.
```

Build (KI-143): `apps/web/vite.local.config.mjs` → `apps/web/dist-local/` (`base: '/'`, input `local.html`, no `netlifyHeaders`, no Google Fonts; `brand/fonts.css` bundles the UI fonts). Script `"build:local": "vite build --config vite.local.config.mjs"`. A guard test fails if any `dist-local/assets/*.js` contains `matrix-js-sdk`, `initRustCrypto`, `.wasm`, `/api/human/` or `khala.aiur.team`. `/` canonicalizes to `/conversations`.

## L14. No-egress log (KI-151)

The `EgressRecord` log line written by the KI-151 guard and read by KI-160/KI-161 is pinned in `docs/build/internal/tickets/KI-151.md` (R18).
