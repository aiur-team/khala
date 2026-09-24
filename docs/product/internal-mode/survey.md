# Khala internal mode: reuse survey

Research only. Source: `~/github/everdred/khala` at `origin/main` = `2a6c929` ("Compose the native agent surface (#130)"), read on 2026-09-24. The unmerged branch `origin/aiur/41-kha-132-wire-real` (KHA-132) is cited where it matters, and is labeled as unmerged each time.

**Feature (operator's words, paraphrased):** run Khala locally so two different models, for example Claude and Codex, can chat. It uses no external auth or services, reuses the existing pub/sub interface, stores the channel locally, and lets the user watch and write through a locally hosted copy of the khala.aiur.team channel UX.

---

## 0. Headline findings

1. **Main has no messaging substrate at all.** `ChannelSubstrate` and `SubscriptionSource` are pure SDK-free interfaces. On `main` their only implementations are test fakes. P16 chose Matrix Synapse on Railway, but the only Matrix adapter (`MatrixSubstrate implements ChannelSubstrate`, browser side) is on the unmerged KHA-132 branch, and no connector-side `SubscriptionSource` adapter exists anywhere. The seam is clean and already has a clear place for a local implementation. For internal mode, "reuse the pub/sub interface" means **implementing these two interfaces locally**. It does not mean unplugging Matrix.
2. **`apps/web` has no entry point on main.** Main has no `index.html`, `main.tsx` or `vite.config.ts`. The features (timeline, create-channel, review, agent-controls, channel) exist only as port-injected React components with per-feature browser harnesses. KHA-132's branch adds `main.tsx` and the human application composition (`createHumanApplication`), and that composition already takes the exact port set a local mode would supply. The "khala.aiur.team UX" therefore does not exist yet as a running app. Internal mode either depends on KHA-132 landing or builds its own composition root over the same features.
3. **Automatic agent-to-agent delivery is deliberately switched off.** `packages/policy/src/trust/gate.ts` `approvedAutomation()` returns `null` (G-AUTOMATION). Every `auto` policy is refused and every event is held. Two models can only chat hands-free if internal mode opens this gate for local composition, with explicit loop limits. That is a product decision, not a code detail.
4. **Only Codex has a tested delivery route, and only the Khala-hosted one.** Codex app-server route B (`khala_hosted_resume`, codex-cli `0.154.0` exactly) is `tested`. The Claude adapter is **fail-closed** (`unsupported`). Its hosted `claude -p --input-format stream-json` route delivered while alive but was rejected only because it did not survive disconnect and resume. In internal mode Khala owns both process lifetimes, so that rejection reason matters less. A local-only Claude hosted route, fenced to local mode, is the cheapest way to get a Claude participant.
5. **Nothing today turns a model's output into a channel message automatically.** In the product, agents reply by running `khala send` or calling the `khala_send` MCP tool (`packages/agent-cli`). Internal mode must choose one of two approaches: have agents call `khala_send` against a local server, or have the harness capture each turn's final assistant message and post it.

---

## 1. Pub/sub and messaging contracts

### 1.1 Transport abstraction (the layers)

| Layer | Interface | File | Role |
|---|---|---|---|
| Contract port, UI-facing | `ChannelPort` (`create`, `prepareIntro`, `resumeIntro`, `send`, `timeline`, `observe`) | `packages/contracts/src/messaging/channels.ts` | What the web features consume |
| Contract ports, identity | `IdentityPort`, `DevicePort`, `AdmissionPort`, `RevocationPort`, `RecoveryPort`, `ControlStore` | `packages/contracts/src/messaging/{identity,devices,admission,revocation,recovery,control-store}.ts` | Sign-in, device lifecycle, invites |
| Channel service | `createChannelService({ principal, actor, device, substrate, journal, limits, clock })` → `ChannelPort` | `packages/messaging/src/channels/index.ts` | Idempotent create, `clientTxnId` send dedupe, intro batches, timeline projection keyed by `eventId`, generation fencing, sha256 digest over `encodeMessageContent` |
| **Substrate SPI (human/channel side)** | `ChannelSubstrate` (`createRoom`, `findCreatedRoom`, `room`, `sendEvent`, `timeline`, `subscribe`) | `packages/messaging/src/channels/substrate.ts` | **The pluggable transport.** Finite results (`done`/`rejected`/`unavailable`/`unknown`), no SDK errors |
| Channel journal | `ChannelJournal` (CAS on revision); `createMemoryChannelJournal` (non-durable) | `packages/messaging/src/channels/journal.ts` | Device-local send/create intents |
| **Subscription SPI (connector side)** | `SubscriptionSource` (`authorize`, `listen(hint/lost)`, `read({cursor,limit})` → `page`/`gap`/`unavailable`/`rejected`) | `packages/connector/src/subscription/adapter.ts` | **Pluggable ingest.** Durable replay from an opaque cursor, plus live content-free hints |
| Subscription loop | `startSubscription({ source, cursors, ingestion, provenance, lock, scheduler, random, onState })` | `packages/connector/src/subscription/index.ts`, `ingest.ts`, `state.ts` | Listen, then replay, then commit the cursor only after durable ingest. Provenance check, backoff |
| Delivery contracts | `ApprovalCommand`, `PolicySetCommand`, `ReleasedJob` (`releaseFromApproval`/`verifyReleasedJob`), `DeliveryReceipt`, `HarnessCapabilities` v2, `HarnessPort` | `packages/contracts/src/delivery/*.ts` | Approval → release → harness |
| Connector storage | `openConnectorStorage` (node:sqlite, STRICT, WAL, EXCLUSIVE lock, 0700/0600) | `packages/connector/src/storage/*.ts` | Pending items, cursors, bindings, approvals, releases, receipts, dispatch ledger |
| Dispatch | `createDispatcher(deps)` | `packages/connector/src/dispatch/*.ts` | At-most-once submit to `HarnessPort`, pause, budget (`maxJobsPerCausalRoot`, `maxConcurrentJobs`), busy policy, `outcome_unknown` |
| Connector runtime | `createConnectorRuntime(config, factories)` | `apps/connector/src/runtime/create.ts`, `harness.ts`, `capabilities.ts`, `composition/agent/harnesses.ts` | Wires storage → device → bootstrap → subscription → controls → harness selection → dispatcher |
| Agent CLI | `khala connect/listen/send/status/mcp-serve`, `AgentClientPort`, durable JSONL inbox | `packages/agent-cli/src/cli/*.ts` | Agent side: receive released bytes and send replies. Default transport fails closed (`composition/unavailable.ts`) |
| Fallback skill | `SKILL.md`, `khala-fallback listen` supervisor | `packages/agent-skill/` | `agent_installed_listener` route (experimental) |

The data flow in the product design:

```
human browser ──ChannelPort──> createChannelService ──ChannelSubstrate──> [transport]
                                                                     │
agent's connector <──SubscriptionSource── [transport] <──────────────┘
   └─ ingest → pending store → (human ApprovalCommand | auto policy) → release
      → dispatcher → HarnessPort.submit → model session
model reply → khala send / khala_send MCP → AgentClientPort.send → [transport]
```

### 1.2 Where Matrix/Synapse plugs in

- **Browser side:** only on the **unmerged KHA-132 branch**, in `apps/web/src/composition/human/matrix-browser.ts`. There, `class MatrixSubstrate implements ChannelSubstrate` feeds `createChannelService`, and `createMatrixBrowserPorts` returns `{ device, room, participant }`. The server side lives in `apps/control/src/composition/human/matrix.ts` (Synapse shared-secret registration, P17 server-minted session).
- **Device/crypto:** `packages/messaging/src/browser-device/` injects `DeviceEngineFactory` and `CryptoStoreFactory` (the IndexedDB Rust crypto store). The README maps these to `initRustCrypto`.
- **Connector ingest:** **no Matrix `SubscriptionSource` exists.** The storage README says the SDK-crash-recovery primitive is still "blocked on G-SUBSTRATE".
- **Infra:** `infra/messaging/` (Synapse + Postgres compose, Railway), `infra/operations/` (backup, restore, upgrade).
- `experiments/{browser-crypto,headless-crypto,headless-verification,client-reuse,ownership}` hold the Matrix feasibility spikes. None of them is production code.

### 1.3 What a local substrate must implement

Minimum, for the human UI plus two agents:

1. **`ChannelSubstrate` (local).** An append-only event log per channel. It must:
   - assign a monotonic `eventId` and `receivedAt`;
   - dedupe `sendEvent` on `(deviceId, clientTxnId)`;
   - tag `createRoom` with `operationId` so that `findCreatedRoom` can answer `absent` with proof (trivial locally);
   - return cursor pages from `timeline`;
   - make `subscribe` fan out updates with the current `generation`.

   It never emits `undecryptable`.
2. **`SubscriptionSource` (local), over the same log.** `authorize` returns `ok` unless the binding is revoked. `listen` provides an in-process `EventEmitter` hint. `read` pages after the cursor (the cursor is the log offset) and returns `SourceEvent{kind:'decrypted', ref, verifiedDeviceId, canonicalPayload}`. Here "decrypted" just means plaintext, and `verifiedDeviceId` is the author device the local server recorded.
3. **A browser transport for (1).** The browser cannot share a Node process, so it needs either:
   - (a) an HTTP + SSE/WebSocket `ChannelSubstrate` client in the browser that talks to the local server, with `createChannelService` running in the browser (the same shape KHA-132 uses for Matrix); or
   - (b) a `ChannelPort` over HTTP, with `createChannelService` running server-side.

   Option (a) reuses more, because the browser keeps the same `ChannelService` semantics and `ChannelJournal` it has in production.
4. **Local identity ports.**
   - `IdentityPort.current()` returns a fixed local `AuthPrincipal`. `providerIssuer` is something like `local:`, and the decoder needs checking to see whether it accepts that (see Unknowns). `beginSignIn` and `signOut` do nothing.
   - `DevicePort` is always `ready` with a local device ID and generation 1.
   - `AdmissionPort`: `share` and `admit` return `forbidden`, or are omitted if the UI hides share/join.
5. **`ControlStore`:** used only by admission and revocation. It can be omitted or backed by the same SQLite file.
6. **Participant mapping:** a fixed roster of `{human, agentA, agentB}` `ParticipantView`s. Timeline attribution (`attribution.ts`) takes `kind` and `ownerId` only from this roster. Locally, all three can share one `ownerId`. That means both agents render as "Your agent", which is probably fine but loses A/B distinction in labels (see Risks).

Storage engine: `node:sqlite` is already the connector's engine, with no new dependency. It is the natural choice for both the channel log and the connector ledger. An alternative is append-only JSONL, following the agent-cli inbox's pattern.

---

## 2. Model harness adapters

| Harness | Adapter | Status on main | Route usable for internal mode |
|---|---|---|---|
| Codex | `packages/harnesses/src/codex/` → `createCodexHarness` | Route B: Khala-hosted `codex app-server --listen unix://…`, `thread/resume`, `thread/queue/add` with `clientUserMessageId=releaseId`. **`tested` for 0.154.0 exactly**, Linux x64. Receipts include `context_consumed` and `completed`. Route A: `codex queue --thread` is notification-only, and bytes go through the local inbox. | **Route B.** Khala starts the app-server itself. It needs a `CodexHostPort` registry and a `CodexClientPort` (WebSocket JSON-RPC over the unix socket); both are ports whose production composition is in KHA-133/153. |
| Claude | `packages/harnesses/src/claude/` → `createClaudeHarness` | **Fail-closed.** `unsupported`; every submit is refused without calling `ClaudeNativeRoutePort`. KHA-145 evidence: hosted `claude -p --session-id … --input-format stream-json --output-format stream-json --replay-user-messages` delivered idle and busy writes while alive, but duplicates were consumed twice and the session did not survive a forced disconnect or `--resume`. | Either (a) a new **local-only** Claude hosted-stream route behind the same checks. It must not be advertised as `tested` for the product, and needs a separate capability record or an explicit local opt-in. Or (b) the fallback skill (`agent_installed_listener`, experimental, opt-in via `allowExperimentalAgentListener`), running in a user-launched Claude session that calls `khala listen` and `khala send`. That costs one human approval per session in default permission mode. |
| Any other | `packages/agent-skill` | experimental listener | Same as Claude (b). |

**How sessions are driven today.** The dispatcher calls `HarnessPort.submit({job, payload})` with the canonical release bytes (`["khala.release.v1", releaseId, …, [[roomId,eventId,author,device,digest,body],…]]`, from `packages/policy/src/release/codec.ts`). The model sees that envelope as its user turn. There is **no output path** in `HarnessPort`. Replies come only from the agent choosing to `khala send`.

**What "two different models" requires:**

- Two `SessionBinding`s (two `bindingId`s, one per agent participant), each with its own harness candidate and dispatch policy.
- A reply path for each (see Headline 5):
  - **R1, explicit send.** Give each model the `khala_send` MCP tool (`khala mcp-serve`) or the skill, pointed at the local server. This is faithful to the product and lets the agent decide when to speak. It needs a local `AgentClientPort` composition, and a turn can end without a reply.
  - **R2, turn capture.** The local harness driver reads the turn's final assistant message: Codex `item/completed` or `turn/completed` notifications (already tracked by `createCodexReceiptTracker`), and Claude `result` stream-json lines. It posts that message as the agent participant. This is deterministic channel exchange, but it is new code, and it bypasses `khala send`.
- Turn-taking and loop limits (see §4 and the questions).
- Prompt framing: the release envelope is JSON. Each model needs a system or intro message that explains the envelope and the other participant. The channel service's `prepareIntro` can carry a scripted intro.

---

## 3. Web channel UX (`apps/web`)

| Feature | Port(s) | Main status | Local needs |
|---|---|---|---|
| `features/timeline` (`TimelineScreen`, `createTimelineController`) | `ChannelPort` (`timeline` + `observe` + `send`), a viewer `ParticipantView` | Built; inert text rendering; send retry by `clientTxnId` | Local `ChannelPort` via `createChannelService` + local substrate. **Core of internal mode.** |
| `features/channel` (`ChannelScreen`, `AgentPresencePanel`) | `ChannelUiPort` (`agents`, `subscribeAgents`, `installCommand`) | Built; HTTP composition in `apps/web/src/composition/human/agent-presence.ts` (polling fetch) | Local presence endpoint: two agents, connection state and route label. `installCommand` returns the local launch hint or can be hidden. |
| `features/create-channel` | `IdentityPort`, `DevicePort`, `ChannelPort`, `AdmissionPort`, `ContentLimits` | Built; includes share-link generation | Reuse for "new channel". The share step is hidden or disabled locally. |
| `features/review` (`ReviewScreen`) | `ReviewUiPort` (`snapshot`, `subscribe`, `approve(ApprovalCommand)`) | Built; live wiring (KHA-134) not landed | Needed only if the human approves deliveries. Backed by local connector storage + `evaluateApproval`. |
| `features/agent-controls` (`AgentControlsPanel`) | `AgentControlsUiPort` (`readSnapshot`, `subscribe`, `submitPolicy(PolicySetCommand)`) | Built; live wiring (KHA-135) not landed | The place for **pause/resume** and review-vs-auto mode per agent. Backed by `evaluatePolicyChange`/`applyPolicyAck` + `applyEffectivePolicy`. |
| `features/join`, `features/recovery` | `AdmissionPort`; `RecoveryPort` | Built | **Drop locally.** No invites, and recovery is Matrix-key-specific. |
| `shell/` (`AiurShell`, `KhalaPageFrame`, tokens, fonts) | none | Built | Reuse as-is for the visual identity. |
| App root | none | **Missing on main.** KHA-132 branch: `main.tsx`, `index.html`, `vite.config.ts`, `composition/human/{application,mount,routes,room,browser-api,matrix-browser,device-session,room-journal}.ts` | `createHumanApplication(ports)` takes `{identity, device, room, admission, participant, limits}`. A local `main.tsx` can call it with local ports and skip `browser-api`/`matrix-browser`. `renderHumanRoom` currently renders review and controls as "not available" placeholders. |

**Without OAuth, the UI needs:**

- a local `IdentityPort` that is always signed in;
- a `DevicePort` that is always ready;
- `PUBLIC_APP_ORIGIN=http://127.0.0.1:<port>`;
- no `PUBLIC_HOMESERVER_ORIGIN`.

`netlify.toml` sets a CSP with `connect-src 'self'`, which works if the local server serves both the bundle and the API from one origin. `create-channel`, `join` and `routes.ts` assume `https` share links. Locally the share UI is hidden. Web Crypto `subtle.digest` needs a secure context, and `http://127.0.0.1` and `http://localhost` count as potentially trustworthy, so `digestMessageContent` works. Serving on a LAN IP would break it and return `crypto_unavailable`.

---

## 4. Trust, approval and dispatch policy

| Piece | File | Locally |
|---|---|---|
| Exact approval release (`evaluateApproval`, `encodeReleasePayload`) | `packages/policy/src/release/` | **Keep.** Pure, and it is the only way to mint a `ReleasedJob`. It is also what gives "human approves before delivery" if that mode is chosen. |
| Trust transitions (`evaluatePolicyChange`, `applyPolicyAck`, `applyRebind`, `trustView`) | `packages/policy/src/trust/transitions.ts` | **Keep.** It drives pause/resume and review/auto mode per binding. The requested-vs-effective split is trivial in-process, where the ack is immediate. |
| Automatic release (`evaluateAutomaticRelease`) | `packages/policy/src/trust/automatic.ts` | **Needed for hands-free channel operation.** It releases only events from the one named peer, only after arming, and bounded by `maxCausalDepth` and the caller's budget. |
| G-AUTOMATION seam (`approvedAutomation()` returns `null`) | `packages/policy/src/trust/gate.ts` | **Blocker.** Internal mode needs a local-composition-only `AutomationConfig`, for example `maxCausalDepth` = the turn cap, without opening the gate for the hosted product. Operator decision. |
| Dispatcher (pause, `maxJobsPerCausalRoot`, `maxConcurrentJobs`, busy `wait/queue/reject`, at-most-once, `outcome_unknown`) | `packages/connector/src/dispatch/` | **Keep.** `maxJobsPerCausalRoot` is effectively the loop limit when one conversation is one causal root. Pause is linearized at claim. |
| Route predicate (`supportedRoute`: `tested` + `busy: queue/reject`, or experimental listener with opt-in) | `packages/connector/src/dispatch/budget.ts`, `apps/connector/src/runtime/harness.ts` | A local Claude hosted route would fail this unless it is `tested` or the predicate gets a local-mode opt-in like `allowExperimentalAgentListener`. |
| Provenance (verified device → participant) | `packages/connector/src/subscription/ingest.ts` | Keep. It is cheap, and it stops agent A's output from being attributed to B. |
| Connector storage invariants | `packages/connector/src/storage/` | Keep. It gives crash safety and exactly-once for free. |
| Retention sweep | `packages/connector/src/retention/` | Optional. Export or delete is simpler locally. |

**Could be skipped locally:** OAuth/OIDC (`apps/control/src/auth`), admission and invites (`apps/control/src/invitations`, `AdmissionPort`), agent bootstrap ownership (`packages/connector/src/bootstrap` loopback-browser-v1, descriptor discovery, Ed25519 proof key), `RevocationPort` protocol side, `RecoveryPort`, Netlify control gateway, and `ControlStore` Blobs.

**Must stay:** human pause/stop, which is the `paused` policy plus a dispatcher `wake`. It is the only brake on two models looping, and the UI already has it in `AgentControlsPanel`.

---

## 5. Existing fakes and harnesses that could be promoted

| Asset | File | Promotable? |
|---|---|---|
| `FakeSubstrate implements ChannelSubstrate` | `packages/messaging/src/channels/fixtures/fakes.ts` | A template for the local substrate: in-memory maps, `landed[]`, listeners. It is under `fixtures/`, which `check:boundaries` bans from production imports and the export map blocks, so it would be **re-implemented** as `local/` production code with durability. It cannot be imported. |
| `createMemoryChannelJournal` | `packages/messaging/src/channels/journal.ts` | Exported and non-fixture, but not durable. A browser session uses it, or a localStorage/IndexedDB journal. KHA-132 branch has `room-journal.ts`. |
| `createMemoryLedger` | `packages/connector/src/dispatch/fixtures/memory-ledger.ts` | Fixture only. Use the real SQLite `createConnectorDispatchStorage` instead. |
| `FakeHarness` / `createFakeHarnessAdapter` | `packages/connector/src/dispatch/fixtures/fakes.ts`, `tests/e2e/harness/reference.ts` | For **CI e2e of internal mode** (fake Codex ↔ fake Claude), not for runtime. |
| `createReferenceConnector`, `createReferenceRoom` | `tests/e2e/harness/reference.ts` | Test-only reference for the connector loop. Good as an oracle for local-mode e2e. |
| Scenario/evidence/faults harness, `describeLive` | `tests/e2e/harness/{scenario,evidence,faults,live}.ts` | Reusable directly for local-mode acceptance, including a live Codex↔Claude run gated by `KHALA_E2E_LIVE`. |
| Conformance suites (`runHarnessConformance`, `runDeliveryConformance`) | `tests/conformance/` | Run any new local Claude route adapter through `runHarnessConformance`. |
| `FakeAppServer` (Codex) | `packages/harnesses/src/codex/fakes.ts` | Tests only. |
| Browser harnesses + `fake-channel-port.ts`, `fake-review-port.ts` | `apps/web/src/features/*/browser-harness/` | Show that each feature runs standalone with injected ports. They are dev pages, not an app. |
| Synapse compose | `infra/messaging/compose.yaml` | Not a fit: it is an external service, which the operator ruled out. |

---

## 6. Encryption: drop vs keep

| Drop locally (Matrix/E2EE-specific) | Why |
|---|---|
| `packages/messaging/src/browser-device/` crypto store, engine, identity marker, Web Locks owner lock | Matrix device keys in IndexedDB. A local device is a constant. |
| `packages/messaging/src/recovery/` | P14 key recovery. There are no keys. |
| `ProtocolRevocationPort` (device removal, outbound session rotation) in `packages/messaging/src/revocation/` | Megolm-specific. Binding revocation stays as a ledger flag. |
| `missing_keys` / withheld / `decrypt_failed` handling: `UnavailableContent` reasons, subscription delayed-key backoff, placeholder replacement | The local source never emits `undecryptable`. The code paths stay but go dormant. |
| `SupportedCryptoMaintenancePort` (retention) | Answer `unsupported`. |
| `bindDeviceIdentity` SDK fingerprint check (connector storage) | Bind a synthetic local fingerprint once. It is not meaningful locally, but it is cheap to keep satisfied. |
| Bootstrap Ed25519 proof key, PKCE loopback grant | These are for remote ownership proof. Locally, the one OS user owns everything. |
| CSP `wasm-unsafe-eval` / `worker-src blob:` | Only for the Matrix WASM crypto worker. |

| Keep | Why |
|---|---|
| sha256 `contentDigest` over `encodeMessageContent` and payload digests | These are integrity checks, not encryption. Approval and release (`sameEventRef`, `verifyReleasedJob`) depend on them. |
| Owner-only file modes (0700 dir, 0600 files), `O_NOFOLLOW`, EXCLUSIVE SQLite lock | The channel log and ledger hold plaintext. Other local users must not read them. |
| Payload never in argv, env or logs (Codex/CLI rules) | `/proc/<pid>/cmdline` is world-readable. |
| Provenance: verified device → participant | Stops mis-attribution between the two agents. |
| Plaintext-at-rest caveat | Same threat limit as the connector README: same-user tools can read it. Say this in the UI and docs. Optional at-rest encryption is a non-goal candidate. |

---

## 7. Architecture options

### Option A: "Local substrate, real pipeline" (recommended)

One Node process, `khala internal` or `khala local`, bound to `127.0.0.1`:

```
                         ┌──────────────────── khala internal (Node, 127.0.0.1:PORT) ───────────────────┐
browser (apps/web        │  HTTP/SSE  ─┐                                                               │
 features + local        │             ▼                                                               │
 main.tsx; ChannelService   │   LocalRoomLog (node:sqlite, ~/.local/share/khala/internal/<chat>/room.db)  │
 in browser over         │     ├─ ChannelSubstrate impl  (server side of the browser's HTTP substrate)    │
 HttpRoomSubstrate)      │     └─ SubscriptionSource impl ×2 (one cursor per agent binding)            │
  ▲ review/controls/     │             │                                                               │
  │ presence via HTTP    │   connector core ×2 bindings: startSubscription → storage (pending)         │
  └──────────────────────┤     → policy: evaluateAutomaticRelease (local AutomationConfig)             │
                         │        or evaluateApproval (human approves in ReviewScreen)                 │
                         │     → createDispatcher → HarnessPort                                        │
                         │          ├─ Codex route B (Khala-hosted app-server)                         │
                         │          └─ Claude local hosted-stream route (new, local-only)              │
                         │     reply path: R2 turn capture → LocalRoomLog.sendEvent as agent,          │
                         │                 or R1 khala_send MCP → local AgentClientPort                │
                         └─────────────────────────────────────────────────────────────────────────────┘
```

- **Reuses:** `createChannelService`, `ChannelPort` and all web features; `startSubscription`; connector storage and the dispatcher; policy release and trust; `createCodexHarness`; `khala` CLI and MCP (if R1); the e2e harness and conformance suites.
- **New code:**
  - `LocalRoomLog` (implementing `ChannelSubstrate` and `SubscriptionSource`);
  - the HTTP/SSE bridge and browser `HttpRoomSubstrate`;
  - local identity, device and presence ports;
  - a local `main.tsx`;
  - a local `AutomationConfig` injection;
  - a Claude hosted-stream route (or the fallback skill);
  - a reply-capture driver (R2);
  - the launcher.
- **Pros:**
  - Maximal reuse, and the same safety invariants as production: at-most-once, pause at claim, and digest-bound release.
  - The loop limit is the existing `maxJobsPerCausalRoot` and `maxCausalDepth`.
  - It also serves as the **first end-to-end proof of the whole pipeline without G-SUBSTRATE**, which closes native-agent-surface risk 4 ("G-SUBSTRATE gates the proof of the whole loop").
- **Cons:**
  - The most moving parts.
  - It depends on KHA-132's composition (or duplicates it), and on KHA-133/134/135 composition that is only partly on main.
  - Two bindings in one connector process need either two storage directories (the storage is one-owner, EXCLUSIVE-lock) or one shared ledger with two bindings. The ledger supports several bindings, but the runtime composes one.
  - Opening G-AUTOMATION locally must be fenced carefully.

### Option B: "Thin local relay" (fastest to demo)

A single orchestrator process owns a SQLite or JSONL channel log and drives strict alternation:

1. Read the last message.
2. Send it to model X's session: Codex app-server `turn/start`, or Claude stream-json stdin.
3. Capture the final assistant text.
4. Append it as X.
5. Hand over to Y.
6. Stop at N turns, a stop phrase, or a human stop.

The browser gets a local `ChannelPort` implemented directly on that log. The service can still use `createChannelService` over a trivial `ChannelSubstrate` so the timeline UI is unchanged. It **skips** the connector subscription, pending store, approval/release and dispatcher.

- **Reuses:** contracts (message shapes, digests, `ChannelPort`), the web timeline, channel and shell features, and possibly `createChannelService`. It reuses low-level Codex/Claude process knowledge from the evidence, but not `HarnessPort`.
- **Pros:**
  - Small and deterministic. No automation gate to open, because the orchestrator is not "the product's auto-release".
  - Easy stop and loop semantics.
  - Human messages are inserted between turns.
- **Cons:**
  - It **does not reuse the pub/sub pipeline**, which is the operator's explicit ask.
  - It diverges from product semantics (no release envelope, no receipts, no at-most-once ledger).
  - It builds a parallel harness driver that will drift from `packages/harnesses`.
  - It proves nothing about the real system.

### Hybrid path

Build Option A's **`LocalRoomLog` substrate, local ports, local `main.tsx` and launcher first**. That is useful on its own: the human UI runs with no auth, and agents connect with `khala listen` and `khala send`. Then add the connector pipeline with R2 capture and the local automation config as a second slice. The first slice also gives KHA-132/153 a no-infra dev target.

---

## 8. Risks

1. **Automation gate leakage.** A local `AutomationConfig` must be impossible to reach from the hosted build, for example through a separate composition root and a boundary-check rule. Otherwise internal mode silently opens G-AUTOMATION in production.
2. **Runaway loops and cost.** Two models can ping-pong indefinitely and burn subscription or API quota. The existing caps count jobs, not tokens or spend. They need defaults plus a visible stop.
3. **Agents with tools acting autonomously.** Hosted Codex and Claude sessions have shell and file tools. Messages from the other model are untrusted input (prompt-injection research, `docs/research/03-prompt-injection.md`). An unattended loop with write access in a real repo is the highest-severity risk. It needs sandboxed or read-only defaults or a scratch workdir.
4. **Claude route honesty.** A local hosted-stream route must not raise the product's Claude capability record to `tested`. The KHA-145 evidence shows duplicate consumption and no resume after a crash, so crash-restart semantics locally are "may deliver twice, or lose on crash".
5. **Exact-version pinning.** Codex support is `tested` for exactly `0.154.0`, and other versions are `unsupported`. The operator's installed CLIs may differ, so local mode needs a policy: permit untested versions under a local flag, or refuse them.
6. **KHA-132 dependency.** The UX the operator wants to mirror is not on main and is not deployed as a working channel. Building a local `main.tsx` now risks duplicating or conflicting with KHA-132's composition.
7. **Contract strictness.** Decoders reject unknown fields and pin `v`. Any local-only field (for example a "local" identity issuer or a new route value) either fits existing shapes or needs a lockstep contract change. `packages/contracts/src/delivery/` is single-writer-owned (KHA-147).
8. **DNS rebinding and CSRF on localhost.** A 127.0.0.1 server without Host and Origin checks, or a token, is reachable by any web page the user visits. The control gateway's `checkMutationOrigin` helps but is Netlify-shaped.
9. **Attribution with a single owner.** Both agents share the local owner, so `attribution.ts` labels both "Your agent". They must be distinguished by display name, and the viewer-relative labels may need a local tweak.
10. **Single-owner storage lock.** `openConnectorStorage` holds an EXCLUSIVE lock for one owner process, so two agents means either one process managing both bindings, or two storage directories.

## 9. Unknowns (to verify in planning)

- Does `decodeAuthPrincipal` accept a non-https `providerIssuer` (such as `local:`) and a synthetic subject? If not, local identity needs a fixture-shaped issuer, which is misleading, or a contract change.
- Can one `createConnectorRuntime` host two bindings, or is one runtime per binding the intended shape? `ConnectorRuntimeFactories.bootstrap` returns one binding.
- Codex route B's capture of final assistant text: `createCodexReceiptTracker` maps notifications to receipts, but does the app-server stream expose the assistant message body in a form we can post (the `item/completed` agentMessage)? That needs a check against 0.154.0.
- Claude `-p` stream-json in a long-lived process: permission prompts (`--permission-prompts none` versus `--permission-mode`), tool sandboxing, and whether `--resume` works after a *clean* exit, not just a forced one. KHA-145 only showed forced-disconnect failure.
- Whether the operator's intended model pair includes the same model on both sides, or non-CLI models (a raw API or a local model such as Ollama). A raw API conflicts with "no external services" unless the model CLIs' own logins are exempt.
- Whether the hosted khala.aiur.team will ever render review and controls in the same channel page. KHA-132's `renderHumanRoom` stubs them. "The same UX" may mean the timeline only.
- Browser `ChannelJournal` durability locally: is memory acceptable, or should it use IndexedDB like KHA-132's `room-journal.ts`?
- How `prepareIntro` should frame a two-model conversation: a system prompt, role cards, the topic, and who speaks first.
