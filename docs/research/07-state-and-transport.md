# Durable state, WebSockets and client state

Research proposal, 16 September 2026. Archon and Aiur are the concrete source-code references. Runtime selection remains open pending product decisions and comparable spikes. Khala's messaging workload requires stronger replay and explicit connection status than Archon's document hint stream.

## Current TypeScript/Netlify decision boundary

TypeScript is required; Netlify Functions and Blobs are preferred; avoid an unnecessary custom Hono daemon. The user is open to Railway-hosted existing OSS backend services when they save substantial development. Matrix is one candidate, not approved. Compare managed or Railway-hosted Matrix + Netlify application code against Netlify Functions/Blobs + maintained OSS endpoint crypto + managed realtime. The detailed build/buy map is in [substrates](02-substrates.md). The owner connector attaches to the existing working session and uses immediate pub/sub; durable replay repairs loss, while periodic polling alone does not satisfy the default.

## Blobs authority design: feasible bounded CAS, not assumed transactions

Verified API facts: `onlyIfNew` creates a key conditionally; `onlyIfMatch` guards a write with its ETag; strong reads are opt-in. No multi-key transaction API is documented. The same documentation still contains generic troubleshooting language saying there is no concurrency control, contradicting its explicit atomic conditional-write examples. Use the explicit API as the candidate contract and verify the pinned SDK against a deployed store before relying on it. [Netlify Blobs API](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).

A feasible design proposal is an immutable object graph with one bounded mutable root per room. First write immutable ciphertext/event nodes and immutable history pages. Then CAS the room root to reference a fully written candidate history version while validating membership/policy version in that same root. Only that CAS commits acceptance. The root contains current authority, head reference and bounded command receipts; readers follow reachable committed objects, never list arbitrary uploaded blobs as the transcript. Lost CAS leaves orphan candidate objects for later collection. This is a proposed application protocol requiring failure tests, not a built-in database feature.

A persistent tree/page structure avoids rewriting the complete history for every append, but adds custom storage-protocol work. Simple fixed-size active pages plus immutable previous pages may suffice under explicitly measured room/retention limits. Compaction, pagination and pruning must preserve reachability and offline retry receipts. Do not claim unbounded scale from a small CAS prototype.

| Invariant | Can Blobs single-root CAS provide it? | Boundary |
|---|---|---|
| Concurrent update to small policy/invite record | Yes, within one key | Strong read + ETag compare + bounded retry; reject stale intent |
| Room-local membership check and message acceptance | Yes, if authority and committed history head share one CAS root | Do not check membership in one blob then commit independently elsewhere |
| Ciphertext persists before accepted receipt | Yes, immutable body/page first, root commit second | Orphans are unaccepted; every referenced body must already be durably written |
| Ordered room history | Yes, root revisions allocate order | Never use wall clock/list ordering as committed order |
| Idempotency | Yes within explicit receipt retention | Receipt/digest linked by committed root; window expiry needs explicit semantics, not silent new send |
| Commit then publish | Eventual recovery, not atomic publish | Commit root before hint; reconcile committed events and repeat hints; duplicate is harmless |
| Atomic update of unrelated room/account roots | Not directly | Co-locate authority, use a recoverable saga with stated semantics, or choose transactional storage |
| Global instant revocation racing writes across rooms | Not from independent CAS records alone | Define room-local revocation semantics or introduce coordinator/transactional authority |
| Exactly-once external model action | No | Existing-session adapter correlation and unknown-outcome handling remain necessary |

The transaction requirement is logical: all fields participating in one acceptance invariant must share a serialization boundary. SQL is not automatically necessary when that boundary fits a bounded room root. Independent keys do not become atomic by using strong reads. If chosen product invariants require cross-root atomicity, a managed transactional database callable from Netlify functions is an alternative; it does not require a hosted Hono service.

For B, functions publish opaque hints after a committed root change and clients fetch/replay authoritative history. A missed final hint requires durable head reconciliation; successful publish alone never means model consumption. A durable publication watermark or queued marker can live in the root; reconciliation must have a complete enumerable room set and bounded scheduling strategy. Background functions cannot be assumed to run forever. Test commit/publish crashes and ensure scheduled repair latency is documented separately from the normal immediate path.

## Matrix interpretation if option A wins

Use SDK sync tokens and event IDs as opaque identifiers; handle limited timelines/history pagination through supported APIs. Do not invent contiguous sequence checks over Matrix IDs. Use SDK crypto persistence rather than custom MLS assumptions. Matrix transaction IDs help sends within their defined scope; application release IDs and harness reconciliation still belong to Khala. No custom socket server is needed for live rooms. [Matrix client-server specification](https://spec.matrix.org/latest/client-server-api/).

Connector-gated approval permits the connector to decrypt pending content. Model-facing reads and notifications expose only approved material. Neither option requires separate encrypted review groups for the selected trust boundary.

## Verified sibling implementation patterns

Inspected working-tree source on 16 September 2026: Archon HEAD `c7d3254`, Aiur HEAD `1f618cddf`. These are source observations, not runtime validation or promises that the sibling implementations meet Khala's guarantees.

| Source | Observed behavior | Khala implication |
|---|---|---|
| `../archon/netlify/lib/store.mjs`, `mutateRecord` | Conditional writes with opaque ETags, bounded retries, separate outage/conflict semantics | Reuse conflict-aware command handling; avoid an ever-growing transcript blob or assumed multi-record atomicity |
| `../archon/netlify/lib/realtime.mjs`, `mintToken` | Separate server/client Ably capabilities; exact returned capability and expiry validation | Preserve least privilege and verify provider responses; no participant may publish relay authority |
| `../archon/templates/base/realtime.js` | EventSource/SSE hint stream, closure-owned credentials, generation guard and shared refresh; failure permanently disables optional realtime silently | Archon is not evidence for a custom WebSocket server. Reuse credential ownership; replace silent degradation with visible offline/catch-up state |
| `../aiur/src/lib/aiur_web/streamdeck_socket.ex` and `streamdeck_channel.ex` | Token verification records generation/expiry; channel subscribes then sends snapshot; expiry timer and configuration-generation change close the channel | Revalidate live authority; distinguish snapshot UI projection from transcript replay |
| `../aiur/src/lib/aiur/events/exchange.ex` | ETS routing and asynchronous process messages | Useful wakeup pattern, not a durable broker; bound consumer queues |
| `../aiur/src/lib/aiur/executor_events.ex` | Journal replay plus live subscriptions; different projection for transient wake events | Preserve durable-history versus wake-hint distinction |
| `../aiur/src/lib/aiur/events/subscription_store.ex` | Hold cursor on transient enqueue failure; buffer later events; dead-letter terminal failures; inline cursor advancement ignores persistence return | Borrow ordered retry, but require durable checkpoint handling and explicit failed-delivery state. Comments about replay are not proof of exactly-once execution |

The concrete wakeup/dispatch boundary is expanded in [agent protocols](01-agent-protocols.md); substrate/runtime choices are in [substrates](02-substrates.md).

## Selected connector-gated authority boundary

Under option A, the Matrix homeserver and SDK own room event, membership and encryption state; under B, the Blobs relay and selected endpoint crypto library provide those functions. Khala adds a local pending-content store, human approval state, approved-delivery projection and durable harness inbox. The connector is trusted with all room plaintext; its model-facing API is restricted to approved material. Release records bind immutable source event/content digest, intended agent instance and policy version. Model output, room text and a mention cannot create a human approval. Replaying a source event or restarting a connector must not reset its review state or silently release it.

The custom relay/audience/MLS details in the remaining sections describe the previously researched stronger boundary and fallback options. They are not additional dependencies for the connector-gated MVP; substrate selection remains open.

## Durable state model

Keep transport events, cryptographic epochs, policy decisions and model execution distinct. A relay sequence orders accepted envelopes; it is not an MLS epoch and does not prove that an endpoint applied the message.

Proposed logical records:

| Record | Durable contents |
|---|---|
| Conversation | ID, lifecycle, membership generation, retention policy |
| Actor/device | Human/agent kind, owner binding, public keys, revocation state |
| Invitation | Secret hash, intended recipient binding, expiry, consumption |
| Encrypted stream entry | Conversation/audience, monotonic sequence, immutable ciphertext, client command ID, transport generation |
| Release | Target agent instance, policy version, opaque approved delivery and minimal routing fields |
| Recipient policy | Peer scope, review/automatic mode, version, authorised human issuer |
| Consumption checkpoint | Device/feed cursor and local application status |
| Publication outbox | Accepted entries awaiting stream fan-out |

Encrypt content-bearing references and approval details where possible. Routing metadata still reveals conversations, endpoint activity, sizes and timing. Define that leakage explicitly rather than calling the relay metadata-blind. Presence, typing and socket liveness remain ephemeral; read receipts and model-consumption receipts are optional disclosure choices.

Do not store a growing conversation transcript as one CAS blob. Archon's guarded writes remain useful for small singleton policy records, but chat needs append-only envelopes, independent cursors and atomic membership/policy checks. Use blob/object storage for encrypted attachments, not an unguarded dual-write authority system.

## Historical/fallback runtime comparison

| Candidate | Implementation approach | Assessment |
|---|---|---|
| Phoenix + Postgres | Channel fan-out; transactional room head, ciphertext log, policies and outbox | Strong candidate when self-hosting and existing BEAM expertise matter |
| Cloudflare Durable Objects + SQLite | One room coordination object; persisted encrypted log; hibernating sockets | Lean managed alternative; prototype browser/native crypto independently |
| Archon-style Netlify + broker | HTTP commands, external push, independent durable replay | Viable HTTP/SSE prototype; additional atomicity work for releases and MLS ordering |

[Phoenix Channels](https://phoenix.hexdocs.pm/channels.html) reconnect/rejoin but deliver server messages at most once and do not persist them. Therefore Phoenix PubSub is a wakeup mechanism, not Khala's transcript. Presence or an actor process must never be the sole authority for membership or policy. Room processes can improve coordination; a durable transaction remains authoritative across restarts and nodes.

[Postgres row locks](https://www.postgresql.org/docs/current/explicit-locking.html) can serialise room-head changes inside a transaction. Proposed send transaction: lock the room head, check membership/generation, validate idempotency, allocate the next room/audience sequence, append ciphertext and an outbox item, commit, then acknowledge. Use a room counter under that lock rather than assuming globally allocated IDs imply commit order. A retry with the same client command ID and identical ciphertext returns the original result; different bytes under the same ID are rejected.

[Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) can keep connections open through hibernation, but in-memory object state is reset. Restore authoritative state from storage and keep socket attachment data minimal. [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) offers transaction facilities; prove the log/policy/idempotency transition using the exact storage API. An `await` in a handler must not be assumed to preserve application-level serial ordering automatically. A room object helps coordination but does not implement MLS.

Do not choose a runtime based on unverified free-tier calculations in the recovered Archon research. Benchmark four actors first, then reconnect bursts, offline catch-up and sustained agent traffic. No load measurements have been run in this continuation.

## Custom relay protocol proposal (conditional)

If option B wins, expose a versioned HTTPS command API and authenticated managed pub/sub for subscribe/replay hints; the browser/connector connects directly to that provider, not to a persistent Netlify socket server. Start with HTTP sends because standard auth, idempotent retries and diagnostic tooling are straightforward. WebSocket sends can share the exact command path later. SSE plus HTTP remains a reasonable alternative where duplex presence is unnecessary.

Proposed frame categories:

```
client: subscribe(feed, after_seq), ping
server: ready(head_seq), entry(seq, ciphertext), resync_required, auth_expiring
client command: submit(command_id, generation, audience, ciphertext)
server receipt: accepted(command_id, seq) | rejected(code)
```

Define framing and size limits before implementation. The relay checks envelope schema, credential scope, membership and generation; it cannot validate plaintext meaning. Signed endpoint controls and cryptographic membership validation remain client responsibilities. Arbitrary claims inside an encrypted message never become relay authority.

Separate relay-originated receipts/control from participant ciphertext and ephemeral frames. Carry over Archon's server/client channel separation, but require endpoint authentication of message authors after decryption. A successful socket authentication is not enough to trust every message the relay sends.

Browser WebSockets cannot use arbitrary Authorization headers. Prefer an authenticated HTTPS bootstrap for a short-lived, single-use socket ticket, sent as the first bounded frame or through a carefully designed upgrade path. Before authentication there is no feed access; cap unauthenticated connection lifetime. Check browser Origin for cookie-authenticated entry points. Do not put long-lived credentials in socket URLs. Native connectors may use their own approved auth path. Revalidate expiry/revocation on live connections; checking only at initial connect leaves stale access.

## Replay and failure semantics

1. Commit ciphertext before acknowledging or streaming it. Never acknowledge durable acceptance from an in-memory queue alone.
2. Stream events may be duplicated or lost. Replay from the authoritative feed sequence; deduplicate by immutable entry identity.
3. Close the replay/live race by establishing a subscription and head watermark, replaying through that watermark, then reconciling later entries. Sequence-gap detection triggers durable fetch even if the live fan-out missed an entry. A missing final event has no later gap to reveal it, so reconnect, periodic head reconciliation, or bounded server heartbeat watermarks must also trigger reconciliation. Use contiguous audience-specific sequence numbers, or opaque cursors with explicit successor semantics; filtered room-wide sequences otherwise create false gaps and leak hidden traffic.
4. The sender checkpoints its pending encrypted command before submission. A lost acknowledgement is resolved by lookup of that command ID; it does not regenerate ciphertext or reuse an MLS generation.
5. Persist receiver crypto state before advertising an applied checkpoint. “Received,” “decrypted,” “released,” “entered model context” and “answered” are separate states. None proves safe action execution.
6. Outbox fan-out is at least once, deduplicated by sequence/ID. It repairs the crash window between database commit and publish.
7. Retention expiry is explicit. If a feed cannot supply needed MLS transitions, require recovery/re-enrolment rather than skipping to a transcript page and pretending crypto synchronised.

Use bounded replay pages and socket queues. Disconnect a slow consumer with a resync instruction rather than buffering indefinitely. Retry with jitter and a cap; show offline/unsynced state. Queue sends locally as pending, never as accepted. Reconnecting does not auto-release a pending airlock batch.

Concurrent MLS commits need an additional application ordering contract. Prototype a generation/epoch compare-and-set per crypto group with client-authenticated transitions and rejection/reconciliation. The relay can serialise claimed transitions but cannot independently prove an encrypted transition is valid. Recipients must detect invalid or forked state; a malicious relay can still censor or equivocate. Do not claim the delivery log solves those threats without client checkpoint comparison.

## Client and connector state management

Start with a TypeScript web client and small explicit stores/reducers, separate from the selected crypto SDK. MLS-specific state applies only if that crypto option is selected. Framework choice is secondary to ownership of transitions.

- Conversation projection: immutable accepted entries indexed by ID/sequence, pending send commands, derived release views. Decrypted data stays client-side and must be excluded from telemetry and generic persistence middleware.
- Crypto manager: one worker/task owner per group, serialized transitions, transactional checkpointing. Its public interface emits verified application events, not raw group secrets.
- Policy projection: authoritative version and pending human changes; UI cannot represent an optimistic policy toggle as committed. Evaluate auto-release using current committed policy at submission.
- Connection manager: `offline -> authenticating -> catching_up -> live`, with expiry/revocation and resync branches. Use generation guards so obsolete callbacks cannot apply to a newly paired instance; share one token refresh operation as Archon does.
- Presence: separate optional leased map; absent presence does not mean a member was revoked or failed to receive a message.
- Model worker: only the connector’s approved delivery feed; the trusted connector itself can hold pending plaintext. Its local durable command registry can avoid duplicate scheduled runs, but model calls/tools need their own idempotency and crash handling. Transport deduplication does not provide exactly-once external actions.

A local MCP adapter can expose `send`, `read_approved`, `wait_for_delivery` and connection status. It must not expose the connector’s pending review content, group secrets or a human approval tool to the model. Automatic wakeup requires actual harness integration; an MCP tool definition alone does not make a coding agent run when a message arrives. Verify the supported revisions and background invocation model of each targeted harness during the connector spike.

## Proof required before implementation planning

Inject response loss, relay restart after commit/before fan-out, connector restart after decrypt/before checkpoint, simultaneous policy toggles, concurrent MLS commits, invite replay, expiry during an open socket, slow consumers and missed fan-out. The pass criteria are invariant-based: no lost accepted envelope within retention, no duplicated local release/inbox scheduling from replay; ambiguous external harness acceptance is explicitly reconciled or shown as unknown, no stale-instance access, and no unapproved plaintext entering the recipient agent. These are proposed tests; no code test suite exists yet.

## Additional ordering and failure decisions

Keep `room_version`, `audience_seq`, `crypto_epoch`, `policy_version`, `agent_instance_generation`, and `harness_turn_id` distinct. They advance for different reasons; no timestamp or globally allocated ID substitutes for a feed's committed order. A retry must bind its idempotency key to actor/device, operation, audience and immutable request digest. Retain deduplication receipts long enough for supported offline retry; after expiry return an explicit unknown/expired result rather than silently creating another send.

Subscribe/replay should use a bounded handoff: register the subscriber, capture a durable high watermark, replay through it, then drain buffered entries above it with deduplication. Buffer overflow restarts catch-up from the last durable cursor. For cross-node pubsub and lost terminal hints, periodically compare authoritative head. `ready` must mean catch-up to a declared watermark, not simply that the socket opened.

Membership revocation must race atomically with acceptance on the authoritative version. A read permission check made at socket join does not authorise every later replay page. A revoke cannot retract ciphertext, keys, or plaintext already obtained; the crypto membership transition controls future decryptability. Recheck policy/target at release acceptance and at dispatch where relevant. State whether an already accepted release survives a later pause/revocation; that is a product decision with a visible receipt, not an incidental queue behavior.

A local checkpoint transaction should commit verified crypto state, processed entry ID and inbox/projection updates together wherever the chosen crypto library permits. Browser multi-tab coordination requires a single crypto owner or an explicit lock/fencing design. A stale tab must not roll back the epoch or submit with reused crypto state. Browser persistence/eviction and connector backup restoration need a recovery contract; replaying ciphertext alone does not reconstruct erased group secrets.

Attachment upload and message commit are separate operations unless the chosen store proves otherwise. Upload an opaque encrypted object, bind its digest/size to the encrypted message, and garbage-collect unreferenced uploads after an explicit grace period. Never let a storage URL become a bypass around audience checks. Attachment encryption and key distribution remain owned by the crypto design.

## Conditional integration ticket replacements

If option A wins, start with (1) managed or Railway-hosted homeserver + TS SDK feasibility and version selection; (2) deployment/auth/device integration; (3) room/history-policy and connector approval integration; (4) SDK sync + client projection + recovery; (5) release/inbox/harness idempotency; (6) limits/operations failure harness. Their acceptance evidence should exercise the invariants below using the actual homeserver and SDK. Replace custom append/outbox/WebSocket tickets unless the spike records a specific unmet invariant that requires custom work.

## Fallback custom-relay ticket slices and acceptance boundaries

| Slice | Dependencies | Minimum evidence |
|---|---|---|
| Versioned envelope and error contract | Identity/audience and retention decisions | Fixtures distinguish all generations/cursors; incompatible versions fail explicitly; ciphertext/metadata limits are specified |
| Durable append and idempotent commands | Runtime selection, contract | Lost acknowledgement returns original receipt; different request under same key conflicts; concurrent revocation cannot admit stale command; commit implies replayability |
| Outbox and live delivery | Durable append | Crash after commit recovers fan-out; duplicate delivery is harmless; bounded slow-consumer handling |
| Authenticated replay and reconnect | Identity, feed, live delivery | Subscribe/replay race, missing final hint, cursor expiry, stale socket generation and revoked replay all have deterministic outcomes |
| Client state and crypto ownership | Crypto engine contract, replay | Offline/pending/accepted states are distinct; obsolete callbacks and tabs cannot mutate current crypto state; checkpoints survive permitted restarts |
| Failure/operations harness | Above slices, connector inbox | Demonstrate invariants with injected failures; report unknown external outcomes; no test assumes model actions are exactly once |

These slices are inputs to the ticket proposal; detailed ce-brainstorm/ce-plan work is gated by the user's sign-off.
