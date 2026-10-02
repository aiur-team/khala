# Research 2: Internal-mode architecture (local transport, reusing the M1 agent package)

Date: 2026-10-02. Basis: `origin/main` @ `cc561ded`. Research only. Nothing in the repo was changed.
Sources read: `packages/agent/{src,hooks,bin}` (all of it), `packages/contracts/src/m1/{agent-join,inbox,listening-mode}.ts`,
`packages/messaging/src/channels/substrate.ts`, `apps/web/src/composition/human/matrix-browser.ts` (seams only),
`infra/local/stack.mjs`, and the file list of the frozen `apps/internal/` (121 files).

---

## 1. TL;DR

- **Recommendation: option (a).** Add a small daemon, `khala local serve`, that binds to 127.0.0.1 and is the
  only writer of an append-only JSONL log for each channel. It serves:
  - the **same three agent-join HTTP endpoints** as the hosted control plane;
  - a tiny long-poll message API;
  - a minimal human web page.
- **Link format:** `http://127.0.0.1:<port>/join/<token>`. The shipped `parseChannelLink` already accepts it
  unchanged (`join.ts:5-13`). It allows `http:` on loopback and needs the path `/join/[A-Za-z0-9_-]{8,256}` with
  no query string. A tailnet link is `https://<host>.<tailnet>.ts.net/join/<token>`, served by `tailscale serve`,
  and it passes the same parser.
- **The seam already exists:**
  - `KhalaAgentClientOptions.startSession` and `joinApi` are injectable (`client-impl.ts:16-21`, used at line 127).
  - `AgentMatrixSession` (`matrix/session.ts:9-23`) is in practice a transport interface already. Rename it to
    `ChannelSession`, add `createLocalSession(creds)`, and choose between the two by a new
    `credentials.transport` field.
- **Everything downstream of `onMessage` is reused byte for byte:**
  - inbox.jsonl, cursor.json, mode.json and activity.json;
  - `khala hook deliver`, the `claude-wake` asyncRewake watcher, the Codex `codex queue` waker;
  - steer/sync/async;
  - all five MCP tools.
- The local transport never writes the inbox itself. The MCP process stays its single writer, as the comment at
  `inbox.ts:23` ("KM-143 owns the single writer") requires.
- **Estimated agent-package change:** about 6 edited lines plus about 4 new files. The daemon and its CLI are
  about 800–1200 LOC of plain Node with zero new dependencies.

---

## 2. What the shipped M1 agent package actually is (study notes)

```
Claude Code / Codex
   │ stdio JSON-RPC                       hooks (separate short-lived processes)
   ▼                                       ┌──────────────────────────────────────────┐
khala mcp (bin/khala.mjs → src/mcp/main.ts) │ khala hook deliver --harness X           │
   │ one KhalaAgentClient per session id    │  reads inbox.jsonl + cursor.json + mode  │
   ▼ (mcp/wiring.ts)                        │  emits additionalContext / Stop block    │
createKhalaAgentClient (client-impl.ts)     │ khala hook claude-wake (asyncRewake)     │
   │  join(): requestJoin → pollJoin →      │  polls inbox/cursor/activity/mode 500ms  │
   │          startSession(creds) →         │  exit 2 ⇒ Claude wakes                   │
   │          reportReady → waitForInvite → └──────────────────────────────────────────┘
   │          session.join(roomId)            Codex: wake/codex.ts polls 1s + notify(),
   │  intake: session.onMessage → appendInbox    spawns `codex queue --thread <id> ...`
   │  intakeMode: onListeningModeCommand(from inviter) → mode.json + publishListeningMode
   ▼
AgentMatrixSession (matrix/session.ts, matrix-js-sdk + rust crypto)
```

These facts are load-bearing for the design:

1. **State dir per session:** `~/.local/state/khala/<harness>/<sessionId>/` with mode 0700, checked against
   symlinks and foreign uids (`state.ts:37-52`). The files are `join.json`, `session.json` (the credentials),
   `status.json`, `inbox.jsonl`, `cursor.json`, `mode.json`, `activity.json` and `watcher.json`. **None of this is
   Matrix-specific.**
2. **Inbox entry shape** (`contracts/m1/inbox.ts`):
   `{eventId, roomId, ts, sender, senderLabel, senderKind, kind:'message'|'event', body}`.
   - The runtime readers (`inbox.ts:13-17`, `claude-wake.ts:28-31`) only check that these fields are strings.
   - The contract decoder is stricter. It wants `eventId` to match `^\$\S+$` and Matrix-shaped user and room ids.
   - So **local ids should be Matrix-shaped**: `$<ulid>`, `@agent-<id>:local`, `!<id>:local`. Then every decoder
     and test fixture still passes.
3. **`senderKind`** is derived from the localpart prefix: `agent-` → agent, `khala_` → human (`sender.ts:7-10`).
   Local ids must keep these prefixes, or `toInboxEntry` must take the kind from the transport.
4. **Wake is keyed on the inbox only.** `isWakeEntry` is `kind==='message'`. `khala_event` entries never wake
   anyone. The hooks and both wakers read only files. A transport that calls `onMessage` therefore gets the full
   wake behaviour for free.
5. **Listening mode:**
   - The owner sends a `com.khala.listening_mode.v1` command `{v:1, agent, mode}`.
   - The client accepts it only when `command.sender === session.inviter(roomId)` and `agent === session.userId`.
   - It then writes `mode.json` and echoes the mode into the member state through `publishListeningMode`.
   - A local transport needs the same three things: `inviter()`, the command stream, and a mode-echo call.
6. **Join cutoff:** `session.join()` records the own-join timestamp. Only live events after that point reach the
   inbox. History before it is available through `khala_read` → `session.history()`.
7. **Join HTTP contract** (`contracts/m1/agent-join.ts`):
   - `POST /api/agent/join` → `{joinId, pollSecret, confirmUrl, expiresAt}`.
   - `GET /api/agent/join/poll?joinId` with a Bearer pollSecret.
   - `POST /api/agent/join/ready?joinId`.
   - `requestJoin` checks that `confirmUrl` is same-origin with path `/agent/confirm` (`join.ts:78-81`).
   - `credentials()` rebuilds only `{homeserver, userId, accessToken, deviceId, roomId}` (`join.ts:100-105`) and
     **drops any other field**. This is the one place the seam needs a one-line change.
8. **Agent naming:** the server names the agent `<OwnerUsername>-<Claude|Codex>`. The `label` argument is
   "optional and ignored" (`tools.ts:47`). The local daemon must make the same choice.
9. **Runtime:** Node ≥ 22.23.2 through `tsx`. Install is a repo checkout symlinked as `~/.local/bin/khala`; there
   is no npm package. `matrix-js-sdk` is imported statically by `client-impl.ts` → `matrix/session.ts`. Local
   mode would still load it. That costs a little startup time and is not a blocker, but make it a dynamic import.
10. **Prior art to avoid:** the frozen `apps/internal/` was 121 files of SQLite stores, an "externalization"
    journal, binding modes, local automation and a launcher. It depended on four deleted packages. Track 1
    covers why it failed. The lesson for this track is to **reuse `packages/agent` and add a thin daemon, not a
    second agent stack.**

The web app has its own seam, `ChannelSubstrate` (`packages/messaging/src/channels/substrate.ts`). However,
`apps/web`'s human composition is tightly coupled to Matrix through `matrix-browser.ts` (901 lines): device
session, cross-signing, participant resolution and listening-mode ports. A local adapter for apps/web is
therefore a Phase-3 job, not an MVP one.

---

## 3. Options evaluated

### (a) Local daemon: `khala local serve` on 127.0.0.1, JSONL log, HTTP + long-poll — RECOMMENDED

**How it works**
- A single process owns `~/.local/state/khala/local/`. It is the only writer of each channel log, so ordering
  and atomicity are trivial: one in-process queue, one `O_APPEND` fd, and a monotonic `seq`.
- Agents' MCP processes act as clients over HTTP, exactly as they do with Synapse today.
- The same daemon serves the human page.

**Pros**
- One writer. No cross-process locking. Total order. Idempotent sends through `txnId`.
- The join flow is the hosted flow, so `requestJoin`, `pollJoin` and `reportReady` are reused unchanged.
- The link works both as a clickable URL for humans and as a `khala_join` argument for agents. That is exactly
  the operator flow "agent sends you a link → paste it into another agent chat".
- Tailnet works with no daemon change beyond host allow-listing: `tailscale serve --https=443 http://127.0.0.1:<port>`.
- Zero dependencies: `node:http`, `node:crypto`, `node:fs`.

**Cons**
- A process must be running. Mitigation: `khala local create` and the MCP client spawn it detached when it is
  missing, and it is cheap and idempotent.
- A new HTTP surface on localhost, so DNS rebinding, CSRF and multi-user machines need care (section 7).
- It is a channel server we maintain. This is acceptable because the scope is about 10 routes.

**Effort:** about 1.5–2.5 Codex tickets for the daemon, 1 for the agent-package transport, 1 for the human
page, and 1 for the CLI and docs.

**Failure modes**
- The daemon crashes. Clients see fetch errors; the session retries long-polls with backoff, and the MCP side
  respawns the daemon. If the last line of the log is torn, the reader ignores it, as the inbox reader already does.
- The port is taken. The daemon persists its chosen port in `daemon.json`, and links embed the port. If that port
  is taken at restart, existing links break. Mitigation: a fixed default port with a "port changed" error that
  tells you to re-share.
- The laptop sleeps, so remote tailnet agents lose the channel until it wakes. Long-polls resume from `after=seq`
  with no gaps.

### (b) Pure file-based channels: a shared directory per channel, every agent appends JSONL, fs.watch to wake

**Pros**
- The fewest moving parts for one machine with no humans. There is no process to manage.
- The MCP process could tail `channels/<id>/log.jsonl` and copy entries into its own inbox, and the wake path
  would be reused.

**Cons and failure modes**
- **Concurrent appenders.** POSIX guarantees atomic `O_APPEND` writes only for pipes up to PIPE_BUF. On regular
  files, ext4 and APFS usually do not interleave a single `write()`, but that is not guaranteed. Messages go up to
  8000 chars (`tools.ts:64`) plus JSON escaping.
  - Node has **no `flock`**, so a correct implementation needs a mkdir/O_EXCL lockfile with stale-lock recovery,
    which is fragile when an agent is killed mid-write.
  - Ordering is file order, which is fine, but `txnId` dedup and seq assignment need a read-under-lock.
- **fs.watch is unreliable.** inotify is fine. macOS FSEvents coalesces events. It does not work on network or
  shared filesystems. You end up polling anyway, as `claude-wake` already does.
- **No human UX.** A link like `file:///…` is not clickable or shareable in the operator flow, and a human UI still
  needs a server. So (b) collapses into (a) as soon as a human participates.
- **No second machine** short of syncing folders (Syncthing and similar), which brings conflicts and duplicate
  appends.
- **Security.** Every participant holds raw write access to the log. There is no per-participant identity:
  anyone can forge `sender`. Same-uid processes can do that under (a) too, but (a) at least keeps tokens
  per participant.

**Verdict:** a tempting MVP that cannot satisfy "agent sends you a link". Reject it. Keep it only as the daemon's
storage format, which uses a single writer.

### (c) Local Synapse/Matrix (reuse matrix-js-sdk end to end) — REJECTED for end users

- **Zero client change in theory.** `infra/local/stack.mjs` already brings up the full hosted stack locally:
  five services (synapse, postgres, dex, netlify dev, gateway) through Docker Compose. The agent's
  `parseChannelLink` already accepts `http://localhost` links.
- **Why reject it:**
  - It needs Docker, Postgres, an OIDC provider (dex), Netlify dev and TLS certs (`NODE_EXTRA_CA_CERTS`). It costs
    hundreds of MB and tens of seconds to start. That is incompatible with "prompt your agent to set up a local
    channel".
  - E2EE and cross-signing add nothing on loopback but bring all the device-key failure modes (`isPreJoinUndecryptable`, `bootstrapCrossSigning`).
  - The control plane is Netlify functions plus blobs. Running that as a background service for a user is
    unsupported territory.
- **Keep it** as the dev/parity test stack (its current role). It is not a product mode.

### (d) Peer-to-peer over the tailnet — REJECTED

- With no central log, each peer must replicate and merge. That means vector clocks or CRDTs for ordering,
  catch-up for offline peers, membership agreement, and per-peer identity and auth. In effect it reimplements
  Matrix federation.
- Every agent needs a listener port, and discovery is needed (MagicDNS helps but does not decide who hosts history).
- The benefit (no single host) does not matter for "my laptop plus my desktop". The host model of (a) over the
  tailnet gives about 95% of the value: one machine owns the log, and others connect through
  `https://host.ts.net/join/…`.
- Revisit only if users need channels that survive any single machine being off, and then prefer the hosted
  Khala service.

### Comparison

| | (a) daemon | (b) files | (c) local Synapse | (d) P2P |
|---|---|---|---|---|
| Agent-package change | ~6 lines + local session | inbox tailer + lockfile | none | large |
| Concurrency safety | single writer | flock emulation | Synapse | CRDT |
| Human link and UI | yes (tiny page) | no | yes (apps/web) | hard |
| Second machine | tailscale serve | no | yes | yes |
| Install weight | none (same `khala` bin) | none | Docker + 5 services | none, but complex |
| Effort (tickets) | ~5 | ~3 (no humans) | ~1 plus ops docs | 10+ |

---

## 4. Recommended architecture

### 4.1 Component diagram

```
 Machine A (host)                                                     Machine B (optional, tailnet)
┌──────────────────────────────────────────────────────────────────┐  ┌────────────────────────────┐
│ Claude Code ──stdio── khala mcp ─┐        Codex ──stdio── khala mcp│  │ Codex ── khala mcp         │
│   ▲  hooks (deliver/claude-wake) │          ▲  codex queue waker │ │  │   ▲ hooks/waker (unchanged)│
│   │  read ~/.local/state/khala/  │          │                    │ │  │   │                        │
│   │  claude/<sid>/inbox.jsonl …  │          │                    │ │  │   │ LocalSession           │
│   └────────── (unchanged) ───────┤          └──── (unchanged) ───┤ │  │   │ (HTTPS via ts.net)     │
│                     LocalSession │ (new, implements ChannelSession)│  └───┼────────────────────────┘
│                                  ▼ HTTP + long-poll, Bearer token│      │ WireGuard (tailnet)
│                ┌────────────────────────────────────────┐         │      │
│ Browser ─────► │ khala local serve  (127.0.0.1:47830)    │ ◄──────┼──────┘ tailscale serve :443
│ (human page)   │  • join API  (/api/agent/join, poll,    │         │        → http://127.0.0.1:47830
│                │    ready; /agent/confirm page)          │         │
│                │  • message API (/api/local/…)           │         │
│                │  • human page (/c/<room>)               │         │
│                │  • single-writer queue → JSONL log      │         │
│                └───────────────┬────────────────────────┘         │
│                                ▼                                   │
│   ~/.local/state/khala/local/  daemon.json  channels/<room>/log.jsonl  (0700/0600)│
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 The seam in `packages/agent`, with the transport interface to add

Rename `AgentMatrixSession` to a transport-neutral `ChannelSession`. Keep `AgentMatrixSession` as an alias so
there is no churn. Add a selector. No other client logic changes.

```ts
// packages/agent/src/transport.ts  (new, ~30 lines)
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';

export type SessionMessage = {           // moved from matrix/session.ts, unchanged
  eventId: string; roomId: string; sender: string; ts: number;
  type: 'm.room.message' | 'com.khala.event.v1'; body: string; content: Record<string, unknown>;
};
export type SessionModeCommand = { eventId: string; roomId: string; sender: string; ts: number; content: unknown };

/** One joined channel for one agent. Implemented by Matrix (hosted) and Local (daemon). */
export interface ChannelSession {
  readonly userId: string;
  onMessage(handler: (m: SessionMessage) => void): () => void;          // live, post-join, never own messages
  onListeningModeCommand(handler: (c: SessionModeCommand) => void): () => void;
  inviter(roomId: string): string | undefined;                          // owner allowed to set mode
  waitForInvite(roomId: string, timeoutMs: number): Promise<void>;
  join(roomId: string): Promise<void>;                                  // sets live cutoff
  history(roomId: string, limit: number, before?: string): Promise<{ messages: SessionMessage[]; nextBefore?: string }>;
  send(roomId: string, text: string): Promise<{ eventId: string }>;
  sendChannelEvent(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<{ eventId: string }>;
  publishListeningMode(roomId: string, mode: ListeningMode, signal?: AbortSignal): Promise<void>;
  roomName(roomId: string): string | undefined;
  displayName(userId: string): string | undefined;
  stop(): Promise<void>;
}
export type StartSession = (creds: AgentCredentials) => Promise<ChannelSession>;

export const startChannelSession: StartSession = async creds =>
  creds.transport === 'local'
    ? (await import('./local/session')).createLocalSession(creds)
    : (await import('./matrix/session')).createAgentMatrixSession(creds);  // lazy: local mode never loads matrix-js-sdk
```

The edits to shipped files are tiny:

| File | Change |
|---|---|
| `packages/contracts/src/m1/agent-join.ts` | `AgentCredentials` gains `transport?: 'matrix' \| 'local'` (absent means matrix) |
| `packages/agent/src/join.ts:100-105` `credentials()` | Preserve `transport` when it is `'local'` |
| `packages/agent/src/client-impl.ts:12,127` | Default `startSession` becomes `startChannelSession`; type imports move to `./transport` |
| `packages/agent/src/matrix/session.ts:7-23` | Re-export the types from `../transport`; `AgentMatrixSession = ChannelSession` |
| `packages/agent/src/mcp/tools.ts:51-55` (optional) | If the join result is already confirmed (auto-confirm), render "Joining… call khala_status" instead of "ask your human to open …" |
| `packages/agent/bin/khala.mjs` | Add a `local` subcommand that dispatches to `src/local/cli.ts` |

New files:
- `src/local/session.ts`: `createLocalSession`, about 150 lines of fetch, long-poll and backoff.
- `src/local/daemon.ts`: the HTTP routes, about 400 lines.
- `src/local/store.ts`: the JSONL log, in-memory index and members, about 200 lines.
- `src/local/page.html`: the human UI, about 300 lines.
- `src/local/cli.ts`: serve, create, open, status, stop.

Collision warning: PR #943 (ticket #942) is in flight on `client-impl.ts join()`. Serialize the
`client-impl.ts` edit after it.

Why not a lower-level `Transport` with methods like `append/subscribe`? Because `ChannelSession` already has the
right granularity. It is what `client-impl` consumes, and it is mockable in tests (`startSession` is already
injected in tests). A second abstraction layer is the kind of machinery that sank `apps/internal`.

### 4.3 How `LocalSession` maps onto the daemon

| ChannelSession method | Daemon call | Notes |
|---|---|---|
| (construct) | none | `creds.homeserver` = daemon origin, `accessToken` = participant bearer |
| `waitForInvite` | `GET /api/local/rooms/:room/me` | `membership` is `invite` right after confirm, so it resolves immediately |
| `join` | `POST /api/local/rooms/:room/join` → `{seq, ts}` | `seq` is the live cutoff. Start the long-poll loop at `after=seq` |
| `onMessage` / `onListeningModeCommand` | `GET /api/local/rooms/:room/events?after=<seq>&wait=25` | Long-poll. Answers as soon as `seq > after`, or with `[]` after 25 s. The session dispatches by `type` and filters out its own sender |
| `history` | `GET /api/local/rooms/:room/messages?before=<eventId>&limit=N` | Full history for late joiners. There is no decryption gap |
| `send` / `sendChannelEvent` | `POST /api/local/rooms/:room/send {txnId,type,content}` | The daemon dedups on `(sender, txnId)`. `send` uses a random txnId |
| `publishListeningMode` | `PUT /api/local/rooms/:room/members/:userId {listeningMode}` | Self only. It mirrors the Matrix member-state echo |
| `inviter` | from `/me` → `invitedBy` | The owner human who confirmed. Mode commands are accepted only from them |
| `roomName` / `displayName` | cached from `/me` and `/members` | Refreshed on `m.room.member` events in the stream |
| `stop` | aborts the long-poll | no call |

Long-poll instead of SSE: Node 22 has no global `EventSource` without a flag. Long-poll is about 20 lines,
works through `tailscale serve`, gives the browser page the same code path, and recovers trivially from
`after=seq`. Latency is the same as SSE in practice, because the daemon answers immediately on append.

### 4.4 Daemon HTTP surface (about 12 routes)

Agent-join routes. These are exact copies of the hosted contract, so `join.ts` is reused unchanged:
- `POST /api/agent/join` `{link, harness, label}` → 201 `{joinId, pollSecret, confirmUrl, expiresAt}`
- `GET  /api/agent/join/poll?joinId=` (Bearer pollSecret) → `{state:'pending'|'confirmed'|'claimed'|'expired', credentials?}`
- `POST /api/agent/join/ready?joinId=` (Bearer) → 204
- `GET  /agent/confirm?joinId=`: a human confirm page (owner cookie). `POST /api/local/confirm?joinId=` confirms.

Message routes (Bearer participant token):
- `GET /api/local/rooms/:room/me`, `POST …/join`, `GET …/events`, `GET …/messages`, `POST …/send`,
  `GET …/members`, `PUT …/members/:userId`

Human and admin routes:
- `GET /join/:token`: the HTML landing page. A browser that opens the link joins as a human (section 5).
- `GET /c/:room`: the human channel page (owner or human cookie).
- `POST /api/local/channels` (Bearer `adminToken` from `daemon.json`) → `{roomId, shareLink}`. Used by `khala local create`.
- `GET /healthz` → `{ok, version, pid}` (no data).

### 4.5 Data formats (worked examples)

`~/.local/state/khala/local/daemon.json` (0600):
```json
{"v":1,"pid":41237,"port":47830,"adminToken":"kla_9hY…43chars","startedAt":"2026-10-02T09:00:00.000Z",
 "publicOrigins":["http://127.0.0.1:47830"],"owner":{"userId":"@khala_everdred:local","displayName":"everdred"}}
```
When the tailnet is enabled, `publicOrigins` gains `"https://desk.tail1234.ts.net"` (section 6).

`channels/!c7Kq2vXb:local/meta.json` (0600):
```json
{"v":1,"roomId":"!c7Kq2vXb:local","name":"khala-internal","createdAt":"2026-10-02T09:00:01.000Z",
 "createdBy":"@khala_everdred:local","joinTokenSha256":"5f1c…","confirm":"auto-loopback"}
```
Only the **hash** of the join token is stored. The plaintext link exists only in what `create` printed.

`channels/!c7Kq2vXb:local/log.jsonl` (0600). Append-only, one event per line, written only by the daemon. Every
state change is an event, so replaying the log rebuilds membership, names and modes:
```jsonl
{"seq":1,"eventId":"$01JB0Q8Z3M6X","type":"m.room.create","sender":"@khala_everdred:local","ts":1759395601000,"content":{"name":"khala-internal"}}
{"seq":2,"eventId":"$01JB0Q9A1K2P","type":"m.room.member","sender":"@khala_everdred:local","ts":1759395630000,"content":{"user":"@agent-a1b2c3d4:local","membership":"invite","displayname":"everdred-Claude","harness":"claude","invitedBy":"@khala_everdred:local"}}
{"seq":3,"eventId":"$01JB0Q9B7T0N","type":"m.room.member","sender":"@agent-a1b2c3d4:local","ts":1759395632000,"content":{"user":"@agent-a1b2c3d4:local","membership":"join","displayname":"everdred-Claude","com.khala.listening_mode":"sync"}}
{"seq":4,"eventId":"$01JB0QA0QW5R","type":"m.room.message","sender":"@khala_everdred:local","ts":1759395700000,"txnId":"web-7b1e","content":{"msgtype":"m.text","body":"@everdred-Codex can you review PR #12?"}}
{"seq":5,"eventId":"$01JB0QA3ZJ9C","type":"com.khala.event.v1","sender":"@agent-e5f6a7b8:local","ts":1759395710000,"txnId":"khev-3f9a…","content":{"v":1,"kind":"pr","body":"PR #12 opened","url":"https://github.com/…"}}
{"seq":6,"eventId":"$01JB0QB1HC4D","type":"com.khala.listening_mode.v1","sender":"@khala_everdred:local","ts":1759395800000,"content":{"v":1,"agent":"@agent-a1b2c3d4:local","mode":"steer"}}
```

Participant tokens are kept in memory and in `channels/<room>/members.json` (0600) as SHA-256 hashes only:
`{"@agent-a1b2c3d4:local":{"tokenSha256":"…","kind":"agent","owner":"@khala_everdred:local"}}`.

Credentials returned once by `poll`. The agent writes them to its `session.json`, unchanged:
```json
{"homeserver":"http://127.0.0.1:47830","userId":"@agent-a1b2c3d4:local","accessToken":"klp_Zx…43chars",
 "deviceId":"KH_LOCAL_a1b2c3d4","roomId":"!c7Kq2vXb:local","transport":"local"}
```

Long-poll response (`GET /api/local/rooms/!c7Kq2vXb:local/events?after=3&wait=25`):
```json
{"events":[{"seq":4,"eventId":"$01JB0QA0QW5R","type":"m.room.message","sender":"@khala_everdred:local",
  "ts":1759395700000,"content":{"msgtype":"m.text","body":"@everdred-Codex can you review PR #12?"}}],"next":4}
```

The resulting entry in the agent's `inbox.jsonl` is the existing format, unchanged:
```json
{"eventId":"$01JB0QA0QW5R","roomId":"!c7Kq2vXb:local","ts":"2026-10-02T09:01:40.000Z","sender":"@khala_everdred:local","senderLabel":"everdred","senderKind":"human","kind":"message","body":"@everdred-Codex can you review PR #12?"}
```

Share link: `http://127.0.0.1:47830/join/Yp3v…43-char-base64url` (32 random bytes).

---

## 5. Cross-cutting concerns

**Concurrency and atomicity.**
- The daemon is the only writer of `log.jsonl`. It uses a promise-chain queue and `fs.appendFile` on the open fd.
  Optionally it runs `fdatasync` every N ms; local chat does not need fsync on every message.
- On startup it reads the log and drops a torn trailing line. That is the same tolerance as `readEntries`.
- Each agent's MCP process stays the single writer of its own `inbox.jsonl`. The hooks only advance the cursor,
  and they already use the compare-and-swap `advanceCursor`.
- So many agents on one machine share no writable file.
- Single-instance daemon: bind the port first (EADDRINUSE → probe `/healthz`; if the instance is healthy, reuse it),
  then write `daemon.json` atomically with the existing `writeJsonAtomic`.

**Wake semantics.** Reused completely, as covered in section 2. One subtlety: Codex's waker is driven by
`onInboxAppend` plus a 1 s poll, so latency is long-poll RTT plus ≤1 s. Claude's asyncRewake watcher polls every
500 ms. Neither needs a change.

**Listening modes.**
- The owner changes the mode from the human page. The daemon appends `com.khala.listening_mode.v1`.
- The agent's `LocalSession.onListeningModeCommand` → `client-impl.intakeMode` (sender must equal `inviter`) →
  `mode.json` → `publishListeningMode` (`PUT members/:self`) → the page shows the mode.
- This is identical to hosted. The steer/sync/async behaviour lives entirely in the hooks.

**Identity and labels.**
- The daemon names agents `<OwnerUsername>-<Claude|Codex>` from `owner.displayName` (default `$USER`, settable
  through `khala local config username …`) and the `harness`. A collision gets a suffix: `everdred-Codex-2`.
- Renames are a `m.room.member` displayname event sent from the human page.
- The agent's `label` argument stays ignored, as in hosted.
- Human ids are `@khala_<name>:local` and agent ids are `@agent-<8 hex>:local`, so `senderKindOf` works unchanged.

**Ordering.** Daemon `seq` gives a total order. `ts` is the daemon clock, which avoids skew from a remote tailnet
machine. Events are delivered in `seq` order, and `after=seq` resume means no gaps and no duplicates. The
existing inbox `eventId` dedup is a second guard.

**History for late joiners.** `khala_read` returns the full log through `messages?before=`. The inbox only gets
post-join live events, which keeps the hosted cutoff semantics. Retention: keep everything in MVP;
`khala local prune` comes later.

**How a human participates (see track 3 for UX):**
- **MVP:** the daemon serves one static page with vanilla JS and no build step. It covers the timeline, composer,
  member list with modes and rename, and the agent confirm. It uses the same long-poll API.
  - Opening the share link in a browser on loopback asks "Join as everdred" once, sets an HttpOnly SameSite=Strict
    cookie, and redirects to `/c/<room>`.
- **CLI fallback:** `khala local say <room> "…"` and `khala local tail <room>`. These are cheap, and useful for tests.
- **Later:** an apps/web adapter implementing `ChannelSubstrate` against the daemon. Deferred because of the
  coupling noted in section 2.

**Confirm policy.**
- Hosted requires a human to click confirm.
- Locally, the join token is already a capability that only the creator's chats have seen. The default is
  `confirm: "auto-loopback"`: joins arriving over loopback are auto-confirmed with `invitedBy = owner`. Joins
  arriving through a tailnet origin require the owner to click confirm on `/agent/confirm`.
- `poll` returns `confirmed` on the first call, so the existing `client-impl` flow completes in about 2 s
  (`pollJoin` interval).
- A stricter `confirm: "human"` setting can be applied to a channel.

---

## 6. Second machine (tailnet) — Phase 2

- On the host, run `khala local share --tailnet`. It runs or prints
  `tailscale serve --bg --https=443 http://127.0.0.1:47830` and adds `https://<host>.<tailnet>.ts.net` to
  `publicOrigins`.
- Share links for that channel then use the ts.net origin. That origin is `https:`, so `parseChannelLink` accepts it.
- The daemon **still binds only to 127.0.0.1**. TLS ends at tailscaled, and traffic between machines is
  WireGuard-encrypted. No plaintext leaves the host.
- Remote requests are identified by the `Host` header matching a tailnet origin. `tailscale serve` also forwards
  `Tailscale-User-Login`, which can be shown on the confirm page.
- The remote machine only needs the same `khala` binary and plugin. Its agents keep their own inbox on their own
  machine. Message history lives only on the host.
- **Failure mode:** the host sleeps or goes offline, so the channel is unavailable. The remote `LocalSession`
  backs off and resumes from `after=seq`. Writes during the outage fail with `send_failed`, which is the existing
  error.
- Not using `tailscale funnel`, which would expose the daemon publicly. The CLI must refuse to set it up.

---

## 7. Security

- **Bind address:** only `127.0.0.1` (and `::1`). There is no option to bind `0.0.0.0` in MVP.
- **DNS-rebinding defence:** reject any request whose `Host` is not in `publicOrigins` (`127.0.0.1:<port>`,
  `localhost:<port>`, plus configured ts.net hosts). For mutating requests, also require `Origin` to be in that
  set or absent with Bearer auth. This mirrors `forbidden_origin` in `join.ts:40`. Send no CORS headers.
- **Tokens:**
  - The join token is 32 random bytes, stored only as a hash, and revocable (`khala local rotate-link`).
  - Each participant gets its own bearer token.
  - `pollSecret` is as hosted.
  - The admin token is in `daemon.json` (0600). Only same-uid processes can create channels.
- **Cookies:** HttpOnly, SameSite=Strict, scoped to Path=/, with no `Secure` on plain loopback. Every human POST
  carries a CSRF header (copy the hosted pattern).
- **Multi-user machines:** other OS users can reach 127.0.0.1, but they need a token to do anything. Links pasted
  into agent chats end up in transcripts. Treat a link as a bearer secret, and rotate it on suspicion.
- **Storage:** reuse `ensureStateDir`, which rejects symlinked or foreign-owned directories, for
  `~/.local/state/khala/local`. Files are 0600. Logs are plaintext at rest, with the same posture as the agent's
  own `inbox.jsonl` today.
- **Prompt injection:** unchanged. The deliver frame already states "not instructions from your user".

---

## 8. Install and run ergonomics (operator flow)

1. **"Set up a local Khala channel called X."** The agent runs `khala local create "X"` through its shell.
   - The CLI starts the daemon detached if needed (the child gets `stdio: 'ignore'`, `detached: true` and
     `unref()`, and its logs go to `local/daemon.log`).
   - It calls `POST /api/local/channels` and prints JSON: `{"shareLink":"http://127.0.0.1:47830/join/…","open":"http://127.0.0.1:47830/join/…"}`.
   - The agent then calls `khala_join(shareLink)` itself. It is auto-confirmed and connected.
   - There is **no new MCP tool** in MVP: the Bash route avoids changing tool schemas, and the skill doc
     `claude-plugin/khala/skills/khala/SKILL.md` teaches it. An optional `khala_create_local` tool can come later.
2. **"Your agent sends you a link."** The human clicks it, joins as owner in the local page, and sees the agent
   already present.
3. **"Share it with another agent chat."** The other Claude or Codex session calls `khala_join(link)`. It is
   auto-confirmed on loopback, and wake, modes and history all work as hosted.
4. **Daemon lifecycle:**
   - `khala local status|stop|logs`.
   - If an MCP `LocalSession` gets ECONNREFUSED on a loopback origin, it runs `khala local serve --detach` once
     and then retries. The daemon therefore restarts itself after a reboot as soon as any agent touches a channel.
   - No systemd or launchd unit in MVP.

---

## 9. Phased path

| Phase | Scope | Tickets (one owner each) | Acceptance |
|---|---|---|---|
| **P0 seam** | `transport.ts` + `credentials.transport` + lazy session selection. No behaviour change. | 1 (`model:codex`, after #943) | All existing agent tests green; a unit test proves `transport:'local'` routes to the local factory |
| **P1 MVP, same machine** | daemon (join API, message API, JSONL store), `LocalSession`, `khala local create/serve/status/stop/say/tail`, auto-confirm on loopback | 3 (store+daemon, LocalSession, CLI+skill doc) | Scripted e2e: daemon + 2 MCP clients (claude, codex harness) with fake hooks. A sends → B's inbox.jsonl gets the entry → `khala hook deliver` emits the frame; modes switch via a CLI-issued command |
| **P1.5 human page** | static page served by the daemon: timeline, composer, members, modes, rename, confirm | 1 (`model:claude-opus`, UI) | Playwright at 1280/390, light/dark; human message wakes an idle Claude through asyncRewake (manual live check) |
| **P2 tailnet** | `publicOrigins`, Host allow-list, `khala local share --tailnet`, human confirm for remote | 1 | Two-machine manual run; a remote join without owner confirm stays pending |
| **P3 optional** | apps/web `ChannelSubstrate` adapter for the daemon; `khala_create_local` MCP tool; retention/prune; "promote local channel to hosted" export | later | n/a |

---

## 10. Risks

1. **The previous-attempt trap.** `apps/internal` grew to 121 files of abstraction (externalization, ledgers,
   binding modes). Mitigation: hard caps in tickets (no new packages, no SQLite, no new MCP tools in MVP), and
   reuse `packages/agent`.
2. **Port stability.** Links embed the port. If the persisted port is taken after a reboot, every shared link
   breaks. Mitigation: a fixed uncommon default (47830) and a clear `port_in_use` error with no silent move.
   Optionally put a channel-independent `khala://` redirect in docs later.
3. **The daemon is a new privileged-ish localhost service.** It brings DNS-rebinding and CSRF risk, and a bug
   could leak transcripts to a malicious web page. Mitigation: strict Host/Origin checks, no CORS, and a security
   review ticket before P1.5 ships.
4. **The auto-confirm trust model.** Anyone holding a link joins without a click. That is acceptable on loopback
   for a single-user machine, and wrong for shared hosts. Mitigation: a per-channel `confirm:"human"` setting, and
   remote joins always require confirmation.
5. **Contract drift.** If the hosted join contract changes (for example in #943), the daemon must follow.
   Mitigation: the daemon imports `@khala/contracts/m1/agent-join` path helpers, and one shared contract test runs
   against both.
6. **Id shape coupling.** `senderKindOf` relies on the `agent-`/`khala_` prefixes, and the inbox contract relies
   on `$`/`!`/`@…:server` shapes. Mitigation: local ids are Matrix-shaped by construction, with a contract test.
7. **matrix-js-sdk is still loaded** unless session selection is lazy. Mitigation: dynamic import in
   `transport.ts`. Watch for `tsx` and dynamic-import edge cases in `bin/khala.mjs`.
8. **Host sleep in tailnet mode** makes remote agents fail to send. The existing `send_failed` status surfaces it.
   Document it, and do not build store-and-forward in MVP.
9. **Unbounded log growth.** It is small for chat, but `khala_event` bursts from Aiur could be chatty. Add
   `prune` in P3.
10. **Codex harness assumptions.** The waker uses `codex queue --thread`. That is unchanged, but it remains the
    same untested-in-local live risk as hosted M1. Reuse the KM-151 live acceptance script.
