# Internal mode core: local server, SQLite substrate, and launcher

Status: research complete, 2026-09-24. Inputs are the fixed decisions in
[`requirements.md`](requirements.md) and the reuse map in [`survey.md`](survey.md).

## Summary

Use one owner process per open chat. It owns a purpose-built SQLite room log,
adapts that log to both `RoomSubstrate` and `SubscriptionSource`, serves a
separate local browser bundle over authenticated loopback HTTP, and is started by
`khala internal`. This preserves the existing room, subscription, policy, and
dispatcher semantics; a thin relay would not.

| Decision | Result |
|---|---|
| Data plane | One append-only local room log is the source for both room/timeline reads and connector replay. Connector ledgers remain separate stores. |
| Browser boundary | Keep `createRoomService` in the browser. Add an HTTP `RoomSubstrate` client and SSE content-free wakeups; recover pending browser operations with PR #120's durable `RoomJournal`. |
| Process boundary | A dedicated internal-mode composition owns SQLite, local identity/device mappings, server lifecycle, and future local automation. Hosted compositions never import it. |
| Authentication | Generate cryptographically random credentials on every start. The launcher opens a fragment-token bootstrap page, which exchanges the fragment for an HttpOnly host-only human cookie and replaces the URL. Each agent reads a distinct binding capability from its own 0600 descriptor, so the server derives attribution instead of trusting request data. |
| Lifecycle | `khala internal` creates a chat; `--resume <chat>` reopens it. Export and delete are explicit offline-safe operations over the same storage API. |
| Delivery | This area supplies the durable source and composition seam only. Harness listening modes and reply delivery remain owned by their E09 research areas. |

## Findings and evidence

| Finding | Evidence | Status |
|---|---|---|
| The transport seams fit the proposed design without an evident Matrix dependency. | `packages/messaging/src/rooms/substrate.ts:68-88` defines `RoomSubstrate`; `packages/connector/src/subscription/adapter.ts:34-81` defines replayable pages, content-free hints, and authority checks. | Interface fit verified; end-to-end sufficiency unproven until one store drives both public consumers. |
| One log can serve both seams. | `RoomSubstrate` needs room lookup, deduplicated sends, cursor pages, and observation; `SubscriptionSource` needs ordered replay after an opaque cursor. The survey maps both onto the same append-only log (`survey.md:58-83`). | Verified design fit; implementation unproven. |
| Existing code already defines restart-safe replay ordering. | The subscription listens before replay and commits its cursor only after durable ingestion (`packages/connector/src/subscription/index.ts:169-189,192-255`). | Verified in source. |
| Existing SQLite code is the security pattern, not a reusable schema. | `packages/connector/src/storage/leases.ts:83-124,199-215` enforces absolute non-symlink paths, 0700/0600 modes, exclusive WAL ownership, and `synchronous=FULL`; `open.ts:88-215` owns a connector-specific ledger lifecycle. | Verified in source. |
| The pinned runtime can support the store without another dependency. | `package.json` pins Node 22.23.2 and the connector already imports `node:sqlite`. Node documents `DatabaseSync` as a synchronous file-backed API introduced in 22.5.0. | Verified in source and [Node 22 documentation](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html). |
| PR #120 is the correct web composition dependency. | Its `createHumanApplication` accepts injected identity, device, room, admission, participant, and limits ports; its current hosted entry adds Matrix separately. | Verified on `origin/aiur/41-kha-132-wire-real`; unmerged. |
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
| Default-browser credential handoff | **Unproven:** the repository has no browser-opening primitive that demonstrates a fragment token stays out of launcher/opener/browser process metadata. Platform support is gated on a real-process proof. |

## Design

### Components and flow

```text
khala internal
  ├─ creates/opens ~/.local/share/khala/internal/<chat>/ (0700)
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
room store does not add tables to `connector.sqlite`. Keep the SQLite core and
both thin SPI adapters below the internal composition root: putting a Node-only
implementation in `@khala/messaging` would make the browser graph reach server
code, while putting both SPIs in either component package would violate the
repository's cross-component boundary.

### SQLite room store

| Concern | Design |
|---|---|
| Files | `<chat>/room.sqlite` plus SQLite companions, all 0600. Chat, connector, export-temporary, and launch-descriptor paths stay below the 0700 chat directory. |
| Identity | Persist the human, agent participants, and device mapping as authenticated local composition data. Request bodies never choose attribution. |
| Rooms | Persist room ID, creation `operationId` (unique), title, membership, and revision. Repeating an operation ID returns the same room; a conflicting title returns `operation_mismatch`. |
| Events | Append a monotonic integer sequence, opaque event ID, author participant/device, `clientTxnId`, canonical message bytes, and `receivedAt`. A unique `(author_device_id, client_txn_id)` constraint makes send retry idempotent. |
| Cursors | Encode the last covered sequence as an opaque versioned cursor. A read scans after it, filters events for that binding, and advances over filtered rows so an agent's own messages cannot stall replay. No retention in v1 means a valid cursor never produces `gap`. |
| Room timeline | `cursor=null` means the newest bounded page, matching the existing contract. Older-page cursors and the snapshot revision come from the same read transaction. |
| Live updates | Commit first, then notify. `RoomSubstrate.subscribe` receives a full local update; each `SubscriptionSource.listen` receives only a content-free wake hint and rereads durable rows. |
| Failure semantics | Validate schema/application ID before use; refuse unknown newer schemas and corruption. Effects return `unknown` only when commit outcome cannot be proved; reads return `unavailable`. |
| Ownership | Reuse the connector storage's path, mode, `O_NOFOLLOW`, companion-file, exclusive lock, WAL, and full-sync patterns, factored into a neutral private-store helper if needed. Do not import connector ledger internals. |

### Loopback server and token bootstrap

| Boundary | Rule |
|---|---|
| Bind | Listen only on the IPv4 literal `127.0.0.1`. Try 4870 upward only on `EADDRINUSE`; fail on every other bind error or when no port remains. Do not enable address reuse. |
| Host | Before routing, require the exact selected authority `127.0.0.1:<port>`. Reject `localhost`, alternate loopback spellings, userinfo, forwarded-host overrides, and duplicate/ambiguous Host values. |
| Bootstrap | Serve a minimal HTML document at `/__khala/bootstrap` that loads only the fixed same-origin script `/__khala/bootstrap.js`. The script reads the token from the URL fragment, POSTs it to the exact origin, and calls `location.replace(<encoded selected-room path>)`. The server compares in constant time, sets the cookie, and invalidates the one-time bootstrap exchange. Fragments avoid token transmission in request targets, history replacement removes it from the visible URL, and both create and resume land on the launcher-selected room rather than PR #120's create route. |
| Credential generation | Generate the human bootstrap token and every agent capability from at least 256 bits of Node cryptographic randomness, encode them as unpadded base64url, and fail closed if generation fails. Inject a deterministic generator only in tests. |
| Browser cookie | Host-only, HttpOnly, `SameSite=Strict`, `Path=/`, and no `Domain`; it expires with the server. A `Secure` cookie cannot be used on plain HTTP, so use a local-only name rather than a misleading `__Host-` name. |
| Agent descriptors | Keep the human bootstrap credential in `launch.json`; write one separate 0600 descriptor per binding with `{v, chatId, origin, bindingId, capability}`. Bind each capability server-side to exactly one participant, device, and route set. Never accept attribution from a body or caller-selected binding ID. Delete/invalidate all descriptors at shutdown and rotate every credential on resume. Modes isolate other OS users, not processes sharing the operator's uid; agents are trusted for local-file credential confidentiality in v1. |
| Requests | Require the human cookie or a binding capability for every API and event stream, then authorize the route for that role. For state-changing browser requests, also require exact Origin and same-origin `Sec-Fetch-Site` when present. Set no CORS allowance. |
| Browser handoff | Keep credentials out of `khala` command arguments, environment variables, request targets, logs, and process titles. A conventional default-browser opener may still expose the fragment URL in opener/browser argv; that secrecy is **unproven**. No v1 platform is supported until a real-process spike inspects launcher, opener, and browser command lines and proves other OS users cannot observe the token, or selects a different handoff. |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; worker-src 'none'`. The explicit `frame-ancestors` and `form-action` directives are required because they do not inherit all desired behavior from `default-src`; see [CSP Level 3](https://www.w3.org/TR/CSP/). |
| Other headers | `Cache-Control: no-store` for HTML/API/token responses, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. |
| Logging | Log request ID, method, normalized route template, status, duration, and error code only. Never log request targets before normalization, headers, cookies, tokens, bodies, message digests, or SQLite values. |

### Browser composition

Build a separate local entry after #41 / PR #120 lands. Reuse its application,
mount, shell, room, timeline, and durable browser journal modules. Supply:

| Hosted port/flow | Internal replacement |
|---|---|
| OAuth `IdentityPort` | Always-signed-in synthetic principal with a valid far-future session timestamp; sign-in UI never renders. |
| Matrix `DevicePort` | Fixed ready local human device, generation restored from local metadata. |
| Matrix `RoomSubstrate` | Browser `HttpRoomSubstrate` against the authenticated same-origin local API. |
| `AdmissionPort` | Add a generic private-create composition mode that omits admission controls and completes after room/introduction creation. The local port remains fail-closed, and share/join routes are absent; hosted mode retains its existing share flow. |
| Recovery | No route, import, panel, or capability registration in the local entry. |
| Hosted route codec | Local codec accepting only the exact selected `http://127.0.0.1:<port>` origin and create/room routes. |

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
a stopped state with the stable chat ID and exact resume command.

### Explicit agent reply path

The launcher must compose the existing `khala send` and `khala_send` MCP
surface with a local `AgentClientPort`; leaving
`createUnavailableClient()` in that path makes deliberate replies impossible.
Each binding receives one explicit `--internal-descriptor <path>` selection.
The adapter opens only that file (no directory discovery), validates its owner,
mode, version, binding, and exact origin, and uses its capability for local
`status` and `send`; `connect` remains unavailable because the launcher
already created the binding. The credential itself never enters argv or the
environment. The launcher-provided MCP/skill introduction names the room,
participant, and deliberate-chat purpose required by D3. Harness installation
and listening-mode delivery remain owned by their dedicated research areas.

### Resume, export, and delete

| Operation | Contract |
|---|---|
| Resume | `khala internal --resume <chat-id>` acquires exclusive ownership, validates the database, rotates launch credentials, starts the next available port, and restores the room/roster/timeline. It never silently creates a missing or corrupt chat. |
| Markdown export | Read one consistent SQLite snapshot and render title/metadata plus messages in sequence order with timestamp and display name. Escape content so a message cannot become export structure. |
| JSONL export | Emit a versioned metadata record followed by one versioned participant/room/event record per line. Preserve canonical body text, IDs, authorship, timestamps, and order; never include launch tokens or connector secrets. |
| Output safety | Write a 0600 temporary file beside the destination, fsync, and rename. Refuse an existing destination unless the caller explicitly opts to replace it. A failed export leaves chat state unchanged. |
| Delete | Require an explicit chat ID and confirmation (or an explicit non-interactive confirmation flag), acquire the same exclusive ownership, invalidate launch state, rename the chat directory to a same-parent tombstone, then recursively remove it without following symlinks. Report partial failure and make no secure-erase claim. |

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

The listening-modes research owns the actual local automation limits and wake
behavior. This design owns only injection and non-leakage.

## Trade-offs and assumptions

| Item | Decision or assumption | Consequence |
|---|---|---|
| Real pipeline vs thin relay | Use the real room/subscription/policy/dispatcher pipeline. | More components, but no second delivery model and meaningful end-to-end evidence. |
| Browser RoomService vs server RoomPort | Keep RoomService in the browser, matching PR #120. | Requires HTTP/SSE substrate methods and a durable browser journal, but avoids duplicating room semantics. |
| Store layout | Room data and connector ledgers are separate files under one chat directory. | Export/delete can treat the chat directory as one unit while migrations and locks stay domain-owned. |
| One process | One owner process manages the room store and all bindings for an open chat. | Avoids cooperative SQLite writers; multi-process attachment is out of scope. |
| Local identity | Use stable synthetic IDs and distinct participant/device IDs under one owner. | Existing viewer-relative labels may need local display-name treatment; no contract extension is assumed. |
| Bootstrap fragment | The launcher may place the human launch token in a URL fragment long enough for the fixed bootstrap script to exchange it. | Avoids query/request logging, but platform process-metadata secrecy remains unproven and gates support. |
| Platform | v1 targets platforms where Node 22, IPv4 loopback, private POSIX-like paths/modes, and a default browser opener are supported. | Windows ACL/launcher behavior is **unproven** and must not be claimed by the first implementation. |

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

## Non-goals

- Matrix, Synapse, OAuth, invitations, sharing, recovery, revocation protocol, or
  encryption for internal chats.
- LAN/remote binding, TLS, multi-user hosting, daemon/service installation, or
  multiple writer processes.
- Harness-specific steer/sync/async delivery, turn capture, Claude/OpenCode
  plugins, MCP piggybacking, read receipts, room discovery, or Make external.
- At-rest encryption or secure erase.
- A turn limit. Pause and stop remain mandatory, but limit policy belongs to
  `listening-modes`.

## Ticket contracts

### 1. Local SQLite room store and transport adapters

| Field | Contract |
|---|---|
| Title | Implement the local SQLite room store |
| Complexity | `complexity:4` |
| Scope | Add a production SQLite core plus composition-owned thin adapters implementing `RoomSubstrate` and binding-scoped `SubscriptionSource`; secure open/schema/migration; persisted roster and device attribution; replay-stable cursors and commit-before-hint notifications. |
| Out of scope | HTTP, browser UI, CLI, exports, connector ledger changes, retention, automation policy. |
| Files/packages | `apps/internal/src/store/**` and `apps/internal/src/composition/local-transport/**` (new); optional neutral private-path helper extracted from connector storage only if both stores consume it; matching `*.test.ts`. Do not re-export Node storage from browser-used `packages/messaging` entry points. |
| Acceptance criteria | Restart preserves rooms/events/roster; repeated `(deviceId, clientTxnId)` returns one event; operation lookup proves found/absent; timeline and subscription pages obey cursor contracts; own filtered events advance a binding cursor; corruption/newer schema/second owner fail closed; 0700/0600 and no-follow rules hold. Before freezing the API, one integration test drives the same real store through `createRoomService` and `startSubscription` using only their public contracts and no Matrix-specific extension. |
| Tests | Real SQLite contract suite for every SPI result; crash/reopen replay; concurrent open refusal; corrupt/foreign/newer schema; mode and symlink attacks. **Wrong-implementation test:** send the same transaction twice across restart and assert one SQLite event and one replayed source event. |
| Blocked by | None after `internal-core` approval. |
| Conflict risk | `room-discovery` and `make-external` may need read APIs. They must use exported store services rather than add direct schema readers. |

### 2. Authenticated loopback server and browser bridge

| Field | Contract |
|---|---|
| Title | Serve internal chats safely on loopback |
| Complexity | `complexity:4` |
| Scope | Node HTTP server; 4870-upward binding; exact Host/Origin/credential enforcement; fragment bootstrap and cookie; injected human/binding credentials; a generic static-asset serving seam tested with fixtures; bounded JSON endpoints and SSE hints for the browser substrate; strict headers and content-free logs. |
| Out of scope | Browser components, automation, harness spawning, LAN access, daemonization. |
| Files/packages | New `apps/internal/src/server/**`, `apps/internal/package.json`, browser HTTP adapter in `packages/messaging/src/local/http/**` if it can remain browser-safe, `scripts/check-boundaries.mjs`, integration tests. |
| Acceptance criteria | With 4870 occupied, bind 4871 on `127.0.0.1`; bootstrap yields a host-only HttpOnly cookie, cleans the URL, and lands on the injected selected-room path; agent routes derive participant/device from distinct binding capabilities; APIs require credentials plus browser mutation Origin checks; SSE carries hints only; CSP has no inline/eval/worker exception; logs contain no message or credential material. The server accepts credentials and assets from its caller; it does not create descriptors or own the final web bundle. |
| Tests | Real HTTP tests for occupied ports, non-loopback/Host variants, missing/wrong token, cross-origin mutations, bootstrap replay, body bounds, headers, SSE reconnect, and sanitized errors; one browser navigation must load the bootstrap HTML plus external script and complete fragment-to-cookie exchange under the declared CSP. **Wrong-implementation test:** send a valid-token mutation with `Host: localhost:<port>` or a hostile Origin and assert rejection before the handler/store is called. |
| Blocked by | `local-sqlite-room-store`. |
| Conflict risk | `setup-cli`, `room-discovery`, and `make-external` may add or consume endpoints. Reserve the versioned local API here; the launcher ticket alone owns descriptor files. |

### 3. Local web entry over the hosted composition

| Field | Contract |
|---|---|
| Title | Compose the hosted chat UI for internal mode |
| Complexity | `complexity:3` |
| Scope | Separate local Vite entry/config and bundle; PR #120 application/mount/room reuse; a generic private-create seam that omits admission controls; local identity/device/admission/route ports; authenticated `HttpRoomSubstrate`; explicit reconnecting/stopped/auth-failed states; hide sign-in, share, join, recovery; local copy for plaintext state. |
| Out of scope | Rebuilding shared UI, Matrix changes, review/control behavior owned by later tickets, hosted entry changes beyond exports required for reuse. |
| Files/packages | After #41 lands: `apps/web/src/internal/**` (new), `apps/web/vite.internal.config.*` (new), public composition exports in `apps/web/package.json`, `apps/web/src/composition/human/**` only where a generic extension seam is required, Playwright/local-entry tests. |
| Acceptance criteria | Create/open/send/observe works against the real loopback server; create and resume bootstrap directly into the selected room without a second create; reload resumes the room and pending operation identities; auth failure is terminal; API/SSE loss preserves visible/pending state and reconnects before showing stopped guidance; there is no sign-in/share/join/recovery route or control; hosted build/share behavior is unchanged; local UI identifies distinct agents by display name. |
| Tests | Component tests for local ports, private-create mode, connection states, and route codec; Playwright create/send/reload/disconnect flow against real HTTP; hosted/local build comparison. **Wrong-implementation test:** navigate directly to `/join?...` and assert not-found with no Join or Sign-in UI, then inspect the local asset graph for recovery/Matrix entry imports. |
| Blocked by | #41 / PR #120; `authenticated-loopback-server`. |
| Conflict risk | `listening-modes`, `read-receipts`, and `room-discovery` will touch room panels/navigation. Keep their ports as injected capabilities and avoid implementing their UI here. |

### 4. Persistent resume, export, and delete operations

| Field | Contract |
|---|---|
| Title | Add internal chat lifecycle operations |
| Complexity | `complexity:3` |
| Scope | Store-level enumerate/open metadata needed by an explicit chat ID; consistent Markdown/JSONL export; overwrite rules; exclusive, symlink-safe delete with confirmation and plaintext/no-secure-erase messaging. |
| Out of scope | General room discovery UI, Make external conversion, backup/sync, secure erase, retention. |
| Files/packages | `apps/internal/src/lifecycle/**` (new), local store read/export APIs under `apps/internal/src/store/**`, fixtures/goldens kept small. The launcher ticket owns CLI argument/output tests. |
| Acceptance criteria | Resume refuses missing/corrupt state; exports are deterministic and exclude secrets; interrupted export leaves no visible partial output; running chats cannot be deleted; deletion removes the named chat only and reports the no-secure-erase boundary. |
| Tests | Restart fixture; Markdown escaping; JSONL round-trip and stable ordering; existing-output refusal; partial-write fault; symlink/tombstone/delete failure. **Wrong-implementation test:** include a message containing Markdown headings/fences/newlines, export, and assert it remains message content rather than changing document structure. |
| Blocked by | `local-sqlite-room-store`. |
| Conflict risk | `room-discovery` may own listing UX and `make-external` may consume export records. Publish versioned lifecycle APIs; do not implement either feature's UI/protocol. |

### 5. Local-only automation authority and build fence

| Field | Contract |
|---|---|
| Title | Fence internal automation from hosted compositions |
| Complexity | `complexity:3` |
| Scope | Refactor automatic-release authority into an injected dependency with the hosted provider closed; add an internal-only bounded provider; enforce import/bundle boundaries; wire pause/stop precedence without choosing listening-mode wake mechanics. |
| Out of scope | Selecting causal/job limits, harness behavior, steer/sync/async delivery, reply capture, read receipts. |
| Files/packages | `packages/policy/src/trust/{automatic,gate}.ts` and tests; local provider under `apps/internal/src/composition/**`; hosted/internal composition tests; `scripts/check-boundaries.mjs`; build graph assertion. |
| Acceptance criteria | Hosted automatic release remains `automation_gated`; internal release requires an explicit bounded provider; loop/budget checks still apply; pause/stop hold delivery; hosted server/browser artifacts contain no local provider dependency. |
| Tests | Policy unit matrix; hosted vs internal composition integration; dependency-graph and bundle-marker checks. **Wrong-implementation test:** build/evaluate the hosted composition with an `auto` policy and assert it holds; the test must fail if a global default or accidental hosted import opens the gate. |
| Blocked by | `listening-modes` (#139) for the chosen local limits and pause/wake contract; `authenticated-loopback-server` for the internal composition root. |
| Conflict risk | High with `listening-modes`, `claude-plugin`, `mcp-piggyback`, and `opencode-bridge`. This ticket owns only authority injection/isolation; those areas own delivery timing and adapters. |

### 6. `khala internal` launcher and end-to-end core

| Field | Contract |
|---|---|
| Title | Launch and resume an internal chat |
| Complexity | `complexity:4` |
| Scope | Add `internal` create/resume/export/delete routing to the existing `@khala/agent-cli`-owned `khala` binary through a lazy delegated entry; own process shutdown; generate/rotate the human token and per-binding capabilities; atomically write/invalidate their 0600 descriptors; add `--internal-descriptor <path>` composition for a local `AgentClientPort` used by `send` and `mcp-serve`; inject credentials and the local web bundle into the server; open the default browser only on proven platforms; wire fake bindings for deterministic CI; add core Playwright/e2e coverage. |
| Out of scope | `npx khala setup`, harness-specific plugin installation, live model acceptance, daemon/service operation, room discovery UI. |
| Files/packages | `packages/agent-cli/src/cli/internal*.ts` as a lightweight lazy delegate; local client selection under `packages/agent-cli/src/composition/**`; `apps/internal/src/composition/**`; package/build metadata; `tests/e2e/internal/**`; CLI reference docs when implemented. Unrelated agent CLI commands must not load browser/server modules. |
| Acceptance criteria | Bare command creates and opens a chat; every successful create/resume prints the stable chat ID and exact redaction-safe resume command; `--resume` restores it with all-new credentials; presenting binding A's descriptor cannot authorize binding B's routes or attribution (same-uid descriptor theft remains an explicit v1 threat limit); each agent's `khala_send` reaches the shared browser timeline through the real local `AgentClientPort`; the local introduction names the room, participant, and deliberate-chat purpose; port fallback is visible without leaking secrets; SIGINT/SIGTERM invalidates descriptors, stops delivery, and closes stores/server; export/delete delegate to lifecycle services; fake human + two fake agents survive restart without duplicate delivery. Platform support additionally requires a real-process proof that the fragment credential is not visible in launcher/opener/browser argv to another OS user; otherwise browser handoff stays explicitly unsupported. |
| Tests | CLI dependency-injected unit tests for arguments/browser failures/signals and descriptor validation; two real local client/MCP instances selected by distinct descriptors, with send/status, server-derived attribution, cross-binding rejection, and browser-timeline assertions; real-process browser-handoff/process-inspection smoke test per supported platform; fake-harness e2e with human interjection, pause/resume, restart, and Playwright timeline. **Wrong-implementation test:** run, send one event, kill after durable ingest but before cursor acknowledgement, resume, and assert the event is delivered once rather than lost or duplicated. |
| Blocked by | `authenticated-loopback-server`, `local-web-entry`, `internal-chat-lifecycle`, `local-automation-fence`; `listening-modes` for the fake mode matrix. |
| Conflict risk | `setup-cli` owns setup/status/remove, and `acceptance` owns live Aiur/model runs. Keep launcher verbs and CI fakes here; defer installation and live tickets to those contracts. |

## Recommended order

1. Land `local-sqlite-room-store`.
2. Land `internal-chat-lifecycle` and `authenticated-loopback-server` on the
   store contract; they may proceed in parallel.
3. After #41 / PR #120, land `local-web-entry` against the server API.
4. After `listening-modes` fixes limits, land `local-automation-fence`.
5. Land `internal-launcher` as the integration PR, then hand its deterministic
   e2e surface to `acceptance` for live Aiur runs.
