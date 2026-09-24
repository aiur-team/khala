# Internal mode core: local server, SQLite substrate, and launcher

Status: research complete, 2026-09-24. Inputs are the fixed decisions in
[`requirements.md`](requirements.md) and the reuse map in [`survey.md`](survey.md).
Repository evidence was read at `fe32f4b424a162732ed65cb7d89bdba8f5d29497`;
the unmerged web-composition dependency was inspected at PR #120 head
`029ec1a3299a49f7cc32fedf1e61c941f0dd1abc`.

## Summary

Use one owner process per open channel. It owns a purpose-built SQLite channel log,
adapts that log to both `RoomSubstrate` and `SubscriptionSource`, serves a
separate local browser bundle over authenticated loopback HTTP, and is started by
`khala internal`. This preserves the existing `RoomSubstrate`,
`SubscriptionSource`, policy, and dispatcher semantics; a thin relay would not.

**Terminology:** every new user- and agent-facing noun is **channel**. Existing
Matrix/internal identifiers such as `RoomSubstrate`, `RoomService`,
`roomId`, the `room` composition port, and `room.sqlite` remain unchanged
here; `channel-terminology` owns their compatibility-safe rename or documented
carve-out.

| Decision | Result |
|---|---|
| Data plane | One append-only local channel log is the source for both `RoomSubstrate` timeline reads and connector replay. Connector ledgers remain separate stores. |
| Browser boundary | Keep `createRoomService` in the browser. Add an HTTP `RoomSubstrate` client and SSE content-free wakeups; recover pending browser operations with PR #120's durable `RoomJournal`. |
| Process boundary | A dedicated internal-mode composition owns SQLite, local identity/device mappings, server lifecycle, and future local automation. Hosted compositions never import it. |
| Authentication | Generate cryptographically random credentials on every start. The launcher prepares and prints a fragment-token bootstrap URL, which exchanges the fragment for an HttpOnly host-only human cookie and replaces the URL; automatic browser handoff is enabled only for an environment profile proven by `browser-handoff-spike`. Each agent first reads a discovery-only capability from its own 0600 descriptor, then receives a rotated binding capability after the D11 human grant, so the server derives attribution instead of trusting request data. |
| Lifecycle | `khala internal` creates a channel; `--resume <channel-id>` reopens it. Export and delete are explicit offline-safe operations over the same storage API. |
| Delivery | This area supplies the durable source and composition seam only. Harness listening modes and reply delivery remain owned by their E09 research areas. |

## Findings and evidence

| Finding | Evidence | Status |
|---|---|---|
| The transport seams fit the proposed design without an evident Matrix dependency. | `packages/messaging/src/rooms/substrate.ts:68-88` defines `RoomSubstrate`; `packages/connector/src/subscription/adapter.ts:34-81` defines replayable pages, content-free hints, and authority checks. | Interface fit verified; end-to-end sufficiency unproven until one store drives both public consumers. |
| One log can serve both seams. | `RoomSubstrate` needs `roomId` lookup, deduplicated sends, cursor pages, and observation; `SubscriptionSource` needs ordered replay after an opaque cursor. The survey maps both onto the same append-only log (`survey.md:58-83`). | Verified design fit; implementation unproven. |
| Existing code already defines restart-safe replay ordering. | The subscription listens before replay and commits its cursor only after durable ingestion (`packages/connector/src/subscription/index.ts:169-189,192-255`). | Verified in source. |
| Existing SQLite code is the security pattern, not a reusable schema. | `packages/connector/src/storage/leases.ts:83-124,199-215` enforces absolute non-symlink paths, 0700/0600 modes, exclusive WAL ownership, and `synchronous=FULL`; `open.ts:88-215` owns a connector-specific ledger lifecycle. | Verified in source. |
| The pinned runtime can support the store without another dependency. | `package.json` pins Node 22.23.2 and the connector already imports `node:sqlite`. Node documents `DatabaseSync` as a synchronous file-backed API introduced in 22.5.0. | Verified in source and [Node 22 documentation](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html). |
| PR #120 is the correct web composition dependency. | Its `createHumanApplication` accepts injected identity, device, internal `room` port, admission, participant, and limits ports; its current hosted entry adds Matrix separately. | Verified on `origin/aiur/41-kha-132-wire-real`; unmerged. |
| A distinct local route codec is required. | PR #120's hosted route codec requires exact HTTPS (`apps/web/src/composition/human/routes.ts:22-31` on that branch), while internal mode is fixed to `http://127.0.0.1:<port>`. | Verified on the unmerged branch. |
| Loopback HTTP does not prevent Web Crypto use. | The Secure Contexts algorithm treats `127.0.0.0/8` as potentially trustworthy. RFC 8252 also recommends a loopback IP literal over `localhost` for native-app loopback listeners. | Verified in [Secure Contexts](https://www.w3.org/TR/secure-contexts/) and [RFC 8252 §7.3/§8.3](https://www.rfc-editor.org/rfc/rfc8252.html). |
| The hosted automation gate is currently closed globally. | `packages/policy/src/trust/gate.ts:1-13` returns no approved automation; `automatic.ts:88-135` therefore holds every automatic release. | Verified in source. |
| Import boundaries can enforce composition isolation. | `scripts/check-boundaries.mjs:86-124` already rejects production fixture imports, non-composition cross-package imports, and browser reachability into connector/harness code. | Verified in source and by a passing local boundary check. |

### Local proofs

| Proof | Result |
|---|---|
| Node 22.23.2 `node:sqlite` proof: create a STRICT WAL table, insert the same transaction twice, close, and inspect owner modes. | Pass: one row remained; directory `0700`, database `0600`. |
| Occupy `127.0.0.1:4870`, then bind from 4870 upward. | Pass: selected `127.0.0.1:4871`. This proves the runtime primitives, not the future launcher implementation. |
| `apps/control/src/runtime/handler.test.ts` | Pass: 29/29, including missing/mismatched Origin and fetch-metadata rejection. |
| `packages/connector/src/bootstrap/loopback.test.ts` | Pass: 11/11, proving the repository's existing one-shot loopback listener behavior. |
| `packages/contracts/src/messaging/{identity,events}.test.ts` | Pass: 74/74; current strict decoders and canonical message encoding are usable by a synthetic local composition. |
| `node scripts/check-boundaries.mjs` | Pass. |
| `packages/connector/src/storage/open.test.ts` | **Unproven in this workspace:** 22 path-sensitive cases stop at `unsafe_path` because the managed sandbox's filesystem root is owned by uid 65534, which the production ancestor check intentionally refuses. The source and tests are evidence of the pattern, not a local pass claim. |
| Default-browser credential handoff | **Unproven:** the repository has no browser-opening primitive that demonstrates a fragment token stays out of launcher/opener/browser process metadata. Automatic opening is gated on a real-process proof for the exact environment profile. |

## Design

### Components and flow

```text
khala internal
  ├─ creates/opens ~/.local/share/khala/internal/<channel>/ (0700)
  ├─ opens room.sqlite + per-binding connector state (0600)
  ├─ writes launch.json + one descriptor per agent (0600)
  ├─ binds 127.0.0.1:4870, 4871, ...
  └─ opens /__khala/bootstrap#token=<token>
       │
       ├─ local browser entry (PR #120 composition, local ports)
       │    └─ HttpRoomSubstrate ── HTTP/SSE ── LocalRoomStore
       │                                      ├─ RoomSubstrate
       │                                      └─ SubscriptionSource × binding
       └─ local server composition ── connector/policy/dispatcher/harness ports
```

The server is the sole writer. SQLite calls are synchronous, so the composition
serializes effects rather than sharing the connection with browser code or
worker processes. Connector ledgers keep their existing schemas and locks; the
`RoomSubstrate` store does not add tables to `connector.sqlite`. Keep the SQLite core and
both thin SPI adapters below the internal composition root: putting a Node-only
implementation in `@khala/messaging` would make the browser graph reach server
code, while putting both SPIs in either component package would violate the
repository's cross-component boundary.

### SQLite channel store

| Concern | Design |
|---|---|
| Files | `<channel>/room.sqlite` plus SQLite companions, all 0600. Channel, connector, export-temporary, and launch-descriptor paths stay below the 0700 channel directory. The SQLite filename remains an internal `RoomSubstrate` detail. |
| Identity | Persist the human, agent participants, and device mapping as authenticated local composition data. Request bodies never choose attribution. |
| Internal `RoomSubstrate` records | Persist `roomId`, creation `operationId` (unique), title, membership, and revision. Repeating an operation ID returns the same record; a conflicting title returns `operation_mismatch`. |
| Events | Append a monotonic integer sequence, opaque event ID, author participant/device, `clientTxnId`, canonical message bytes, and `receivedAt`. A unique `(author_device_id, client_txn_id)` constraint makes send retry idempotent. |
| Cursors | Encode the last covered sequence as an opaque versioned cursor. A read scans after it, filters events for that binding, and advances over filtered rows so an agent's own messages cannot stall replay. No retention in v1 means a valid cursor never produces `gap`. |
| Channel timeline | `cursor=null` means the newest bounded page, matching the existing contract. Older-page cursors and the snapshot revision come from the same read transaction. |
| Live updates | Commit first, then notify. `RoomSubstrate.subscribe` receives a full local update; each `SubscriptionSource.listen` receives only a content-free wake hint and rereads durable rows. |
| Failure semantics | Validate schema/application ID before use; refuse unknown newer schemas and corruption. Effects return `unknown` only when commit outcome cannot be proved; reads return `unavailable`. |
| Ownership | Reuse the connector storage's path, mode, `O_NOFOLLOW`, companion-file, exclusive lock, WAL, and full-sync patterns, factored into a neutral private-store helper if needed. Do not import connector ledger internals. |

### Loopback server and token bootstrap

| Boundary | Rule |
|---|---|
| Bind | Listen only on the IPv4 literal `127.0.0.1`. Try 4870 upward only on `EADDRINUSE`; fail on every other bind error or when no port remains. Do not enable address reuse. |
| Host | Before routing, require the exact selected authority `127.0.0.1:<port>`. Reject `localhost`, alternate loopback spellings, userinfo, forwarded-host overrides, and duplicate/ambiguous Host values. |
| Bootstrap | Serve a minimal HTML document at `/__khala/bootstrap` that loads only the fixed same-origin script `/__khala/bootstrap.js`. The script reads the token from the URL fragment, POSTs it to the exact origin, and calls `location.replace(<encoded selected-channel path>)`. The server compares in constant time, sets the cookie, and invalidates the one-time bootstrap exchange. Fragments avoid token transmission in request targets, history replacement removes it from the visible URL, and both create and resume land on the launcher-selected channel rather than PR #120's create route. |
| Credential generation | Generate the human bootstrap token and every agent capability from at least 256 bits of Node cryptographic randomness, encode them as unpadded base64url, and fail closed if generation fails. Inject a deterministic generator only in tests. |
| Browser cookie | Host-only, HttpOnly, `SameSite=Strict`, `Path=/`, and no `Domain`; it expires with the server. A `Secure` cookie cannot be used on plain HTTP, so use a local-only name rather than a misleading `__Host-` name. |
| Agent descriptors | Keep the human bootstrap credential in `launch.json`; write one 0600 descriptor per agent context. Before grant it contains `{v, channelId, origin, discoveryCapability}` with list/request scope only; after grant, rotate it to `{v, channelId, origin, bindingId, capability}`. Bind each post-grant capability server-side to exactly one participant, device, and route set. Installed MCP/plugin entries receive only `--internal-descriptor <path>` and read the selected port and token from that runtime file; credentials are never embedded during setup. Never accept attribution from a body or caller-selected binding ID. Delete/invalidate all descriptors at shutdown and rotate every credential on resume. Modes isolate other OS users, not processes sharing the operator's uid; agents are trusted for local-file credential confidentiality in v1. |
| Requests | Require the human cookie or a binding capability for every API and event stream, then authorize the route for that role. For state-changing browser requests, also require exact Origin and same-origin `Sec-Fetch-Site` when present. Set no CORS allowance. |
| Browser handoff | Keep credentials out of `khala` command arguments, environment variables, request targets, logs, and process titles. A conventional default-browser opener may still expose the fragment URL in opener/browser argv; that secrecy is **unproven**. No v1 automatic browser handoff is supported until a real-process spike defines a reproducible environment profile—OS/process-visibility controls, opener implementation, and browser invocation path—and proves from a separate unprivileged OS user that the token is not observable, or selects a different handoff. The launcher still starts and prints the local URL for manual opening. |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; worker-src 'none'`. The explicit `frame-ancestors` and `form-action` directives are required because they do not inherit all desired behavior from `default-src`; see [CSP Level 3](https://www.w3.org/TR/CSP/). |
| Other headers | `Cache-Control: no-store` for HTML/API/token responses, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. |
| Resource bounds | Authenticate and authorize before reading request bodies. Set finite header, body, handshake, request, and idle timeouts; cap unauthenticated connections and credential-scoped SSE streams; close excess/slow clients without disturbing established authorized clients. |
| Static assets | Resolve only fixed manifest entries beneath one canonical bundle root. Reject absolute paths, encoded traversal, mixed-separator traversal, and symlink escapes before filesystem access. |
| Logging | Log request ID, method, normalized route template, status, duration, and error code only. Never log request targets before normalization, headers, cookies, tokens, bodies, message digests, or SQLite values. |

### Browser composition

Build a separate local entry after #41 / PR #120 lands. Reuse its application,
mount, shell, internal `room` port, timeline, and durable browser journal modules. Supply:

| Hosted port/flow | Internal replacement |
|---|---|
| OAuth `IdentityPort` | Always-signed-in synthetic principal with a valid far-future session timestamp; sign-in UI never renders. |
| Matrix `DevicePort` | Fixed ready local human device, generation restored from local metadata. |
| Matrix `RoomSubstrate` | Browser `HttpRoomSubstrate` against the authenticated same-origin local API. |
| `AdmissionPort` | Add a generic private-create composition mode that omits admission controls and completes after channel/introduction creation. The local port remains fail-closed, and share/join routes are absent; hosted mode retains its existing share flow. |
| Recovery | No route, import, panel, or capability registration in the local entry. |
| Hosted route codec | Local codec accepting only the exact selected `http://127.0.0.1:<port>` origin and create/channel routes after `channel-terminology` lands. |

Keep local browser code in a distinct entry/config and local Node composition in
a distinct app/package. The normal hosted Vite entry and Netlify composition
must have no dependency path to either local server code or a local automation
configuration. A build-graph assertion makes that property executable.

The local entry must also make transport state explicit. A rejected/expired
bootstrap is terminal and instructs the user to relaunch. Initial API failure
and SSE loss show a reconnecting state with bounded backoff while preserving the
last timeline, draft, and journaled operations. Sending is disabled while the
server is unreachable; outcomes already marked `unknown` remain pending for
journal reconciliation. After the retry budget or a clean server shutdown, show
a stopped state with the stable channel ID and exact resume command.

### Explicit agent reply path

The launcher must compose the existing `khala send` and `khala_send` MCP
surface with a local `AgentClientPort`; leaving
`createUnavailableClient()` in that path makes deliberate replies impossible.
Each binding receives one explicit `--internal-descriptor <path>` selection.
The adapter opens only that file (no directory discovery), validates its owner,
mode, version, binding, and exact origin, and uses its capability for local
`status` and `send`; `connect` remains unavailable because the D11
discovery/grant flow creates the binding before the bound descriptor is issued. The credential itself never enters argv or the
environment. The launcher-provided MCP/skill introduction names the channel,
participant, and deliberate channel-messaging purpose required by D3. Harness
installation and listening-mode delivery remain owned by their dedicated
research areas.

The launcher does not create a binding merely because an agent has a descriptor.
An unjoined agent receives only the discovery-only capability defined by
room-discovery RD8, `internal-channel-discovery`; a binding is created after
room-discovery RD4b, `channel-access-prompt`, records an explicit human grant.
This is the D11 handoff, not a second admission path in the launcher.

`setup-cli-plan` must block on `authenticated-loopback-server` and install only
the descriptor path. It may not snapshot a selected port or token into MCP or
plugin configuration.

### Resume, export, and delete

| Operation | Contract |
|---|---|
| Resume | `khala internal --resume <channel-id>` acquires exclusive ownership, validates the database, rotates launch credentials, starts the next available port, and restores the channel/roster/timeline. It never silently creates a missing or corrupt channel. |
| Markdown export | Read one consistent SQLite snapshot and render title/metadata plus messages in sequence order with timestamp and display name. Escape content so a message cannot become export structure. |
| JSONL export | Emit a versioned metadata record followed by one versioned participant/channel/event record per line. Preserve canonical body text, IDs, authorship, timestamps, and order; never include launch tokens or connector secrets. |
| Output safety | Write a 0600 temporary file beside the destination, fsync, and rename. Refuse an existing destination unless the caller explicitly opts to replace it. A failed export leaves channel state unchanged. |
| Delete | Require an explicit channel ID and confirmation (or an explicit non-interactive confirmation flag), acquire the same exclusive ownership, invalidate launch state, rename the channel directory to a same-parent tombstone, then recursively remove it without following symlinks. Report partial failure and make no secure-erase claim. |

### Keeping local automation out of hosted builds

Do not change `approvedAutomation()` to return a global default. Instead, make
automation authority an explicit server-composition dependency: hosted
composition supplies the existing closed provider; the internal app alone may
supply a bounded local provider. Keep the provider in the internal server
package, not `packages/policy` or `apps/web`.

Enforce the boundary three ways:

1. `scripts/check-boundaries.mjs` permits the local provider only from the
   internal composition and rejects it from hosted web/control/connector roots.
2. The hosted bundle graph contains neither the internal package nor a stable
   local-automation marker; the internal bundle/server does.
3. A policy integration test proves the same `auto` state is
   `automation_gated` under hosted composition and bounded under internal
   composition; pause and stop still win.

`listening-mode-contract` owns the actual local automation limits and pause/wake
behavior. This design owns only injection and non-leakage.

## Trade-offs and assumptions

| Item | Decision or assumption | Consequence |
|---|---|---|
| Real pipeline vs thin relay | Use the real `RoomSubstrate`/`SubscriptionSource`/policy/dispatcher pipeline. | More components, but no second delivery model and meaningful end-to-end evidence. |
| Browser RoomService vs server RoomPort | Keep internal `RoomService` semantics in the browser, matching PR #120. | Requires HTTP/SSE substrate methods and a durable browser journal, but avoids duplicating those semantics. |
| Store layout | Channel data and connector ledgers are separate files under one channel directory. | Export/delete can treat the channel directory as one unit while migrations and locks stay domain-owned. |
| One process | One owner process manages the channel store and all bindings for an open channel. | Avoids cooperative SQLite writers; multi-process attachment is out of scope. |
| Local identity | Use stable synthetic IDs and distinct participant/device IDs under one owner. | Existing viewer-relative labels may need local display-name treatment; no contract extension is assumed. |
| Bootstrap fragment | The launcher may place the human launch token in a URL fragment long enough for the fixed bootstrap script to exchange it. | Avoids query/request logging, but environment-specific process-metadata secrecy remains unproven and gates automatic browser opening. |
| Environment | v1 targets environments where Node 22, IPv4 loopback, private POSIX-like paths/modes, and a defined browser invocation path are supported. | Automatic opening is claimed only for the exact proven OS/process-visibility/opener/browser profile. Windows ACL/launcher behavior is **unproven** and must not be claimed by the first implementation. |

## Risks

| Risk | Mitigation |
|---|---|
| DNS rebinding or cross-site access to localhost | IPv4-literal bind, exact Host, exact Origin on mutations, SameSite cookie, per-launch token, no CORS. |
| Token leakage | Fragment bootstrap, external script, immediate `location.replace`, 0600 descriptor, redacted logs, rotation on every launch. |
| Caller-selected attribution | Separate per-binding capabilities and server-side capability-to-participant/device/route mapping prevent a client from choosing identity in its request body. This does not stop a same-uid process from stealing another descriptor. |
| Duplicate or lost delivery after restart | Durable event log, unique transaction key, replay-stable cursors, commit-before-hint, connector cursor commit after ingest. |
| Corruption or two launchers | Application/schema IDs, integrity checks, fail-closed open, one exclusive owner. |
| Hosted automation opens accidentally | Explicit dependency injection plus source-graph, bundle-graph, and behavior tests. |
| PR #120 changes composition exports | Block local web work on #41; consume public exports only and do not duplicate its root. |
| Other E09 work writes the same CLI/UI files | Sequence shared-surface tickets and keep core contracts narrow; conflict notes below identify likely owners. |
| Plaintext disclosure to the same OS user | State the threat limit. Modes protect against other users, not same-user processes or unrestricted agents. |
| Same-user agent impersonation | v1 does not claim process isolation: an unrestricted agent sharing the operator's uid can copy another descriptor or `launch.json`. Describe per-binding capabilities as API attribution controls, not a sandbox boundary; run autonomous harnesses in the separately specified restricted workspaces. |
| Unbounded persistent history exhausts disk | v1 deliberately has no retention or turn quota. Surface `SQLITE_FULL`/filesystem exhaustion as a durable write failure, stop further automated sends, and keep export/delete/recovery available where reads still succeed; do not claim this design prevents a same-uid process from consuming disk directly. |

## Non-goals

- Matrix, Synapse, OAuth, invitations, sharing, recovery, revocation protocol, or
  encryption for internal channels.
- LAN/remote binding, TLS, multi-user hosting, daemon/service installation, or
  multiple writer processes.
- Harness-specific steer/sync/async delivery, turn capture, Claude/OpenCode
  plugins, MCP piggybacking, read receipts, channel discovery, or Make external.
- At-rest encryption or secure erase.
- A turn limit. Pause and wake policy belongs to `listening-mode-contract`;
  session Stop and launcher shutdown are specified separately below.

## Ticket contracts

Each row named **Blocked by** contains contract slugs only. The `acceptance`
contract owns the full fake-harness CI journey and live model/provider runs;
internal-core retains one launcher smoke test plus focused component/contract
tests, not a second end-to-end suite.

### 1. Local SQLite channel store and transport adapters

| Field | Contract |
|---|---|
| Slug | `local-sqlite-channel-store` |
| Title | Implement the local SQLite channel store and listening-mode adapter |
| Complexity | `complexity:4` |
| Scope | Add a production SQLite core plus composition-owned adapters implementing `RoomSubstrate`, binding-scoped `SubscriptionSource`, and the `listening-mode-store` port; secure open/schema/migration; persisted roster, device attribution, mode state, replay-stable cursors, and commit-before-hint notifications. |
| Out of scope | HTTP, browser UI, CLI, exports, connector ledger changes, retention, mode policy, automation limits. |
| Files/packages | `apps/internal/src/store/**`, `apps/internal/src/composition/local-transport/**`, and `apps/internal/src/listening-mode-store/**` (new); optional neutral private-path helper extracted from connector storage only if both stores consume it; matching `*.test.ts`. Do not re-export Node storage from browser-used `packages/messaging` entry points. |
| Acceptance criteria | Restart preserves channels/events/roster and the canonical listening mode; repeated `(deviceId, clientTxnId)` returns one event; timeline and subscription pages obey cursor contracts; own filtered events advance a binding cursor; the mode adapter passes the shared port suite; corruption/newer schema/second owner fail closed; 0700/0600 and no-follow rules hold. One integration test drives the same real store through `createRoomService` and `startSubscription` using only public contracts. |
| Tests | Real SQLite contract suites for all three ports; crash/reopen replay; concurrent open refusal; corrupt/foreign/newer schema; mode and symlink attacks. **Wrong-implementation test:** send the same transaction twice across restart and assert one SQLite event and one replayed source event. |
| Blocked by | `listening-mode-contract`. |
| Conflict risk | `internal-channel-discovery`, `listening-mode-dispatch`, and `make-external` consume store APIs. They must use exported adapters rather than add direct schema readers. |

### 2. Authenticated loopback server and browser bridge

| Field | Contract |
|---|---|
| Slug | `authenticated-loopback-server` |
| Title | Serve internal channels safely on loopback |
| Complexity | `complexity:4` |
| Scope | Node HTTP server; 4870-upward binding; exact Host/Origin/credential enforcement; fragment bootstrap and cookie; injected human/binding credentials; manifest-only static assets rooted beneath the local bundle; bounded JSON endpoints, connection/time limits, and credential-scoped SSE hints; strict headers and content-free logs. |
| Out of scope | Browser components, descriptor creation, automation, harness spawning, LAN access, daemonization. |
| Files/packages | `apps/internal/package.json`, `apps/internal/src/server/**` (new), browser-safe HTTP adapter under `packages/messaging/src/local/http/**`, `scripts/check-boundaries.mjs`, and colocated integration tests. |
| Acceptance criteria | With 4870 occupied, bind 4871 on `127.0.0.1`; bootstrap yields a host-only HttpOnly cookie, cleans the URL, and lands on the selected channel; agent routes derive participant/device from binding capabilities; APIs require credentials plus browser mutation Origin checks; SSE carries hints only; CSP has no inline/eval/worker exception; logs contain no content or credentials. The caller supplies credentials and assets. |
| Tests | Real HTTP tests for occupied ports, Host variants, wrong tokens, cross-origin mutations, bootstrap replay, bounds, slow/incomplete requests, excess connections/streams, static absolute/encoded/mixed-separator/symlink escapes, headers, SSE reconnect, and sanitized errors; one browser navigation completes the external-script fragment exchange under the declared CSP. **Wrong-implementation test:** send a valid-token mutation with `Host: localhost:<port>` or a hostile Origin and assert rejection before the body or store is read. |
| Blocked by | `local-sqlite-channel-store`. |
| Conflict risk | `setup-cli-plan`, `internal-channel-discovery`, and `make-external` may consume endpoints. This ticket owns the versioned local API, not descriptors or the final web bundle. |

### 3. Local web entry over the hosted composition

| Field | Contract |
|---|---|
| Slug | `local-web-entry` |
| Title | Compose the hosted channel UI for internal mode |
| Complexity | `complexity:3` |
| Scope | Add a separate local Vite entry/config and bundle; reuse the `human-flow-composition` application/mount/internal `room` port; add a generic private-create seam; supply local identity/device/admission/route ports and authenticated `HttpRoomSubstrate`; render reconnecting/stopped/auth-failed states; hide sign-in, share, join, and recovery. |
| Out of scope | Rebuilding shared UI, Matrix changes, discovery approval UI, Stop control, hosted entry changes beyond reusable exports. |
| Files/packages | `apps/web/src/internal/**`, `apps/web/vite.internal.config.*`, public composition exports in `apps/web/package.json`, `apps/web/src/composition/human/**` only for a generic extension seam, and local-entry browser tests. |
| Acceptance criteria | Create/open/send/observe works against the loopback server; create and resume land directly on the selected channel; reload preserves operation identities; auth failure is terminal; transport loss preserves state and reconnects before stopped guidance; there is no sign-in/share/join/recovery route or control; hosted build/share behavior is unchanged; distinct agents retain display attribution. |
| Tests | Component tests for local ports, private-create mode, connection states, and route codec; focused browser navigation against real HTTP; hosted/local build comparison. **Wrong-implementation test:** navigate to `/join?...` and assert not-found with no Join or Sign-in UI, then inspect the local asset graph for recovery/Matrix entry imports. |
| Blocked by | `authenticated-loopback-server`, `channel-terminology`, `human-flow-composition`. |
| Conflict risk | `listening-mode-ui`, `read-receipts`, `channel-access-prompt`, and `stop-control` touch channel panels. Keep their ports as injected capabilities and do not implement their UI here. |

### 4. Persistent resume, export, and delete operations

| Field | Contract |
|---|---|
| Slug | `internal-channel-lifecycle` |
| Title | Add internal channel lifecycle operations |
| Complexity | `complexity:3` |
| Scope | Store-level open metadata for an explicit channel ID; consistent Markdown/JSONL export; overwrite rules; exclusive, symlink-safe delete with confirmation and plaintext/no-secure-erase messaging. |
| Out of scope | General channel discovery UI, Make External conversion, backup/sync, secure erase, retention, CLI parsing. |
| Files/packages | `apps/internal/src/lifecycle/**`, store read/export APIs under `apps/internal/src/store/**`, and small fixtures/goldens. |
| Acceptance criteria | Resume refuses missing/corrupt state; exports are deterministic and exclude secrets; interrupted export leaves no visible partial output; running channels cannot be deleted; deletion removes only the named channel and reports the no-secure-erase boundary. |
| Tests | Restart fixture; Markdown escaping; JSONL round-trip/order; existing-output refusal; partial-write fault; symlink/tombstone/delete failure. **Wrong-implementation test:** export a message containing headings/fences/newlines and assert it remains content rather than document structure. |
| Blocked by | `local-sqlite-channel-store`. |
| Conflict risk | `internal-channel-discovery` may own listing UX and `make-external` may consume export records. Publish versioned lifecycle APIs; implement neither feature here. |

### 5. Local-only automation authority and build fence

| Field | Contract |
|---|---|
| Slug | `local-automation-fence` |
| Title | Fence internal automation from hosted compositions |
| Complexity | `complexity:3` |
| Scope | Refactor automatic-release authority into an injected dependency with the hosted provider closed; add an internal-only bounded provider; enforce import/bundle boundaries; enforce the limits and pause/wake contract selected by `listening-mode-contract`. |
| Out of scope | Choosing causal/job limits, harness delivery mechanics, steer/sync/async implementation, reply capture, read receipts. |
| Files/packages | `packages/policy/src/trust/{automatic,gate}.ts` and tests; local provider under `apps/internal/src/composition/**`; hosted/internal composition tests; `scripts/check-boundaries.mjs`; build graph assertion. |
| Acceptance criteria | Hosted automatic release remains `automation_gated`; internal release requires an explicit bounded provider; shared loop/budget checks and pause/wake precedence hold; hosted server/browser artifacts contain no local provider dependency. |
| Tests | Policy unit matrix; hosted/internal composition integration; dependency-graph and bundle-marker checks. **Wrong-implementation test:** build/evaluate hosted `auto` policy and assert it holds; fail if a global default or hosted import opens the gate. |
| Blocked by | `authenticated-loopback-server`, `listening-mode-contract`. |
| Conflict risk | High with `listening-mode-dispatch`, `claude-plugin`, `mcp-result-piggyback`, and `opencode-bridge`. This ticket owns only authority injection/isolation. |

### 6. Local agent client and runtime descriptor

| Field | Contract |
|---|---|
| Slug | `local-agent-client` |
| Title | Select a local `AgentClientPort` from a runtime descriptor |
| Complexity | `complexity:3` |
| Scope | Define the browser-neutral versioned descriptor value contract; add `--internal-descriptor <path>`; securely read and validate the exact 0600 file at runtime; select a local `AgentClientPort` for `send`, `status`, and `mcp-serve`; keep `connect` unavailable; ensure installed MCP/plugin entries store only the descriptor path and never a port/token. Discovery-only descriptors have list/request scope and no send/receive until the D11 grant produces a binding descriptor. |
| Out of scope | Creating channels, writing descriptors, launching the server/browser, setup installation, harness delivery, admission decisions. |
| Files/packages | Pure value schema/decoder in `packages/contracts/src/internal/descriptor.ts` with its package export/tests; secure descriptor writer under `apps/internal/src/descriptor/write.ts`; new `packages/agent-cli/src/composition/internal.ts` owns exact-file reading, mode/owner/no-follow checks, decoding, and tests; new focused CLI/MCP modules plus minimal registrations in the real shared files `packages/agent-cli/src/cli/app.ts`, `packages/agent-cli/src/cli/main.ts`, `packages/agent-cli/src/cli/types.ts`, and `packages/agent-cli/src/mcp/server.ts`. |
| Acceptance criteria | The option opens only the named file; validates owner/mode/no-follow/version/origin/binding; the package imports only the pure contracts export and never `apps/internal`; credentials never enter argv/environment/config; binding A cannot select B; `khala send` and `khala_send` use server-derived attribution; an unjoined agent cannot send or receive and can only use the discovery capability; unrelated commands do not load internal client modules. |
| Tests | Descriptor owner/mode/symlink/version/origin cases; CLI/MCP selection parity; send/status success; cross-binding rejection; discovery-only denial; shared-file registration tests. **Wrong-implementation test:** point binding A at a copied descriptor for B and assert the server rejects A's route/attribution attempt. |
| Blocked by | `authenticated-loopback-server`, `channel-access-prompt`, `internal-channel-discovery`. |
| Conflict risk | Highest in the four shared `agent-cli` files with `mcp-inbox-batch`, `mcp-result-piggyback`, `listening-mode-pull`, and `setup-cli-plan`; add modules and keep each registration diff minimal. |

### 7. `khala internal` launcher

| Field | Contract |
|---|---|
| Slug | `internal-launcher` |
| Title | Launch and resume an internal channel |
| Complexity | `complexity:4` |
| Scope | Add `internal` create/resume/export/delete routing through a lazy delegated entry; start/stop the owner process; write/rotate/invalidate `launch.json` and per-agent 0600 runtime descriptors; inject the local bundle and credentials into the server; print the stable channel ID, exact resume command, and manual local URL; request browser opening only for environment profiles proven by `browser-handoff-spike`. Consume D11 discovery/grant outputs—never infer or silently create an agent binding. |
| Out of scope | `--internal-descriptor` client behavior, setup/plugin installation, browser-handoff proof, full fake/live acceptance, daemon/service operation, discovery/admission policy. |
| Files/packages | New `apps/internal/src/launcher/**` and `apps/internal/src/composition/**`; new `packages/agent-cli/src/cli/internal.ts` and tests; minimal command/type/delegation registrations in `packages/agent-cli/src/cli/app.ts`, `packages/agent-cli/src/cli/main.ts`, and `packages/agent-cli/src/cli/types.ts`; package/build metadata and CLI reference docs. |
| Acceptance criteria | Bare command creates a channel; `--resume <channel-id>` restores it with all credentials rotated; export/delete delegate to lifecycle services; port fallback is visible without secrets; failure to open a browser prints the manual URL and does not abort launch; no binding exists before the explicit D11 human grant; SIGINT/SIGTERM invalidates descriptors, closes stores/server, and makes the local URL unreachable. |
| Tests | Focused argument, signal, descriptor-write, and opener-failure unit tests, plus one launcher smoke that create→server readiness→shutdown→resume reaches the real server/store without a fake harness or live model. **Wrong-implementation test:** start with a discovery-only agent and assert launch creates no binding/send capability before the recorded human grant. |
| Blocked by | `authenticated-loopback-server`, `channel-access-prompt`, `internal-channel-discovery`, `internal-channel-lifecycle`, `local-agent-client`, `local-web-entry`. |
| Conflict risk | High in the shared CLI registration files with `setup-cli-plan`; the delegated module owns behavior while root edits stay minimal. `acceptance` owns all broader fake/live journeys. |

### 8. Browser handoff process-metadata spike

| Field | Contract |
|---|---|
| Slug | `browser-handoff-spike` |
| Title | Prove a default-browser handoff does not expose the launch token |
| Complexity | `complexity:2` |
| Scope | Build real-process evidence for explicit environment profiles covering OS/process-visibility controls, opener implementation, and browser invocation path while transferring the fragment credential; inspect launcher, opener, and browser argv/process metadata from a separate unprivileged OS user. Either prove the token is not observable or select and prove a safer handoff. Publish the supported-environment matrix and a narrow opener adapter contract. |
| Out of scope | Blocking `khala internal`, server authentication redesign, UI behavior, claiming untested Windows/desktop support. |
| Files/packages | `experiments/internal-mode/internal-core/browser-handoff/**` for the proof; follow-up adapter/tests under `apps/internal/src/launcher/browser-handoff/**` only for environment profiles the proof passes. |
| Acceptance criteria | Each supported environment profile has repeatable cross-user evidence covering all three process layers and a redacted report; automatic opening stays disabled when the runtime profile cannot be established or differs from the proof. Regardless of result, launcher fallback continues to print the local URL for manual opening, so launch itself is not blocked on this spike. |
| Tests | Environment-profile process-inspection harness run from a separate unprivileged user, with a unique canary and negative-control leak; adapter unit tests only after that exact profile passes. **Wrong-implementation test:** pass the canary URL directly as opener argv and require the harness to detect and fail the leak. |
| Blocked by | `authenticated-loopback-server`. |
| Conflict risk | Low with `internal-launcher`: the launcher exposes an opener seam and fallback now, but does not claim auto-open support until this spike proves it. |

### 9. Session Stop control and server lifetime

| Field | Contract |
|---|---|
| Slug | `stop-control` |
| Title | Stop agent sessions without stopping the local channel server |
| Complexity | `complexity:3` |
| Scope | Add the internal UI Stop control and authenticated server endpoint that terminate all active agent sessions/delivery while leaving the owner server, channel timeline, and browser view running. The accessible flow confirms that every agent session—not the channel server—will stop; disables repeat submission during teardown; reports success with a link into the existing D11 replacement-session flow; and reports partial/error outcomes with remaining sessions plus retry. Keep launcher-process shutdown as the only normal server stop. |
| Out of scope | Implementing a second discovery/grant flow, pause/wake semantics, hard-cancel behavior, deleting channel state, browser close as server authority, daemon/service management. |
| Files/packages | `apps/web/src/internal/controls/StopControl.tsx` and tests; `apps/internal/src/server/stop/**`, `apps/internal/src/composition/session-control/**`, and focused HTTP/composition tests. |
| Acceptance criteria | Human-cookie-authorized Stop requires confirmation, ends agent sessions and delivery, rejects their old binding capabilities, and leaves the timeline/API/browser usable; a partial teardown names remaining active sessions without claiming success and permits retry; replacement sessions invoke `internal-channel-discovery` and `channel-access-prompt` unchanged while the server stays up; closing the browser alone changes nothing. Closing the launcher stops the server and makes the URL unreachable; only then does `khala internal --resume <channel-id>` restart it with rotated credentials and the preserved channel. |
| Tests | Confirmation, disabled/in-progress, success, partial/error/retry, keyboard/focus/announcement states; Host/Origin/human-role endpoint checks; multi-agent session teardown; post-Stop timeline read; launcher shutdown reachability. **Wrong-implementation test:** click Stop and assert agent calls fail while the human timeline endpoint still returns the channel; fail if the server/store is closed. |
| Blocked by | `authenticated-loopback-server`, `channel-access-prompt`, `internal-channel-discovery`, `internal-launcher`, `listening-mode-contract`, `local-web-entry`. |
| Conflict risk | High with listening-mode UI/session controls; this ticket owns only terminal session Stop and the server endpoint, while `listening-mode-contract` owns pause/wake. |

## Recommended order

1. Land `listening-mode-contract`, then `local-sqlite-channel-store`.
2. Land `internal-channel-lifecycle` and `authenticated-loopback-server` in parallel.
3. Land `local-web-entry` after `human-flow-composition` and `channel-terminology`.
4. Land `local-automation-fence` after the shared limits and pause/wake contract.
5. Land `local-agent-client` after `channel-access-prompt` and
   `internal-channel-discovery` freeze the D11 grant/discovery seams.
6. Land `internal-launcher`; `browser-handoff-spike` may proceed independently
   and never blocks the printed-URL fallback.
7. Land `stop-control`, then hand the composed system to `acceptance` for the
   full fake-harness and live runs.
