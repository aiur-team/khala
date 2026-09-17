# Messaging substrate and runtime options

Research continuation, 16 September 2026. This report separates the product substrate from hosting technology. User constraints: TypeScript; maximize OSS reuse; prefer Netlify Functions and Blobs, without an unnecessary custom Hono/backend daemon; an existing OSS backend hosted on Railway is acceptable if it substantially reduces implementation work. Connector-gated approval is accepted. Matrix is a candidate, not selected. Specific infrastructure and tickets await sign-off.

## What changed since the recovered survey

The recovered report primarily answered where two organisations could run a conversation quickly. The present task is to design Khala as an Aiur product with its own identity, review, and delivery experience. Slack/email can still validate behavior, but choosing them as a prototype is different from selecting Khala's canonical store or encryption boundary. Historical star counts, prices, client deadlines, broad competitor claims, and effort estimates in [the recovered survey](recovered/02-substrates.md) were not independently revalidated here and must not become planning inputs.

The product decision is whether Khala owns conversation semantics on a minimal encrypted relay, or adapts an existing messaging system. Federation, operator confidentiality, self-hosting, and peer organisation identity are separate requirements. One shared relay can serve multiple organisations without being federated; self-hosting that relay does not add federation.

## Substrate shortlist

| Option | Evidence and fit | Additional Khala work / uncertainty |
|---|---|---|
| Purpose-built ciphertext relay | Gives Khala ownership of review policy, consent, receipts, and minimal UI | Must build durable feeds, key lifecycle, operations, abuse limits, clients; no claim that this is fastest |
| Matrix | Official client-server API defines room sync and encrypted messaging facilities | Prove device verification, history policy, headless agent key lifecycle, and connector approval isolation; existing clients may expose an unsuitable workflow |
| AGNTCY SLIM | Project describes secure low-latency messaging and group communication | Spike SDK/crypto/runtime interoperability and offline history; a messaging layer is not a complete human approval product |
| Slack/email/Zulip bridge | Useful optional access paths for existing communities | Treat each bridge as a participant trust boundary; plaintext export changes confidentiality; do not promise E2EE through an ordinary plaintext destination |

Sources: [Matrix client-server specification](https://spec.matrix.org/latest/client-server-api/), [SLIM project](https://github.com/agntcy/slim). The table's fit and remaining-work assessments are engineering recommendations, not claims of benchmarked superiority. The rest of the recovered candidate inventory remains background research; no shortlist exclusion based on an unverified release date is intended.

**Current recommendation:** compare two TypeScript architectures before selecting infrastructure. The [hosting decision brief](11-hosting-tradeoffs.md) recommends validating Synapse on Railway, but no substrate is approved. A managed Matrix service buys more messaging functionality; a Netlify/Blobs relay fits the preferred hosting footprint but leaves more protocol and crypto integration to Khala. Neither requires a Hono daemon. Archon is the concrete reference for the second option.

## Netlify-first build versus reuse

| Capability | A: Netlify TS UI/functions + Matrix (managed or Railway) | B: Netlify TS functions/Blobs + OSS endpoint crypto |
|---|---|---|
| Room event persistence/replay | Buy/use homeserver + SDK sync | Build bounded CAS-rooted event history and replay API |
| Membership/device/auth | Matrix primitives + Khala owner mapping | Existing auth library/provider + custom scoped room/device delegation |
| Endpoint E2EE | Existing Matrix SDK; prove TS connector persistence | Select maintained OSS crypto protocol/library; prove browser/Node persistence and recovery |
| Realtime | Matrix SDK sync directly to chosen homeserver | Managed pub/sub such as Archon's Ably pattern; clients connect directly; publish opaque hints from functions |
| Custom state in Blobs | Small Khala config/invitation/mapping records only; avoid duplicate transcript | Ciphertext immutable objects + bounded room roots, policy and dedup metadata |
| Khala custom work | Branded UI, connector approval/inbox, existing-session adapters | Same work plus relay/history/authority protocol and crypto integration |
| Infrastructure operated by user | Netlify project; managed Matrix account OR Railway homeserver/database/storage; local connector | Netlify project; managed realtime account unless a streaming alternative is proven; local connector |
| Long-lived custom hosted daemon | None | None |

Immediate notification is a requirement. In B, realtime is operationally required unless a tested bounded streaming alternative meets it; periodic polling alone does not satisfy the default. Both architectures still need the owner-side connector alive while the existing working session is attached. That local process is not a separately hosted backend service.

**Matrix hosting boundary:** Synapse is a persistent homeserver application with database/media/configuration needs, not a Netlify Function. Managed Matrix avoids operating it; self-hosting requires separate container/VM infrastructure. The TS requirement applies to Khala code and adapters; using an external OSS homeserver written in another language is a dependency choice to approve. [Synapse installation](https://element-hq.github.io/synapse/latest/setup/installation.html), [Element managed hosting setup](https://docs.element.io/latest/element-cloud-documentation/element-matrix-services/how-to-get-an-ems-server/).

**Netlify runtime facts checked 16 September 2026:** synchronous functions have a 60-second limit, scheduled functions 30 seconds, and background functions 15 minutes. Streaming responses also have a 60-second limit and 20 MB response limit. A background invocation is a finite job, not an always-on room listener. [Function configuration](https://docs.netlify.com/build/functions/configuration/), [streaming API](https://docs.netlify.com/build/functions/api/), [background functions](https://docs.netlify.com/build/functions/background-functions/).

No persistent inbound WebSocket server capability was established from current Functions documentation. Edge documentation lists a WebSocket API, which alone does not prove inbound upgrades or unlimited connection lifetime. Do not infer either universal impossibility or a supported socket-hosting design from that list. Use direct managed realtime connections or Matrix sync; bounded SSE requires reconnect/replay and measured latency. [Edge API](https://docs.netlify.com/build/edge-functions/api/).

Blobs supports conditional single-key writes and strong reads, enabling useful durable state without SQL. It does not document multi-key transactions. The precise feasible room design and limits are in [state and transport](07-state-and-transport.md). Netlify preference therefore does not imply an unguarded last-write-wins transcript, and transaction concerns do not automatically require a daemon.

## What is free and what is commercial

Matrix is an open communications standard. Synapse is an open-source homeserver available under AGPL, with a commercial-license alternative; its repository explicitly permits directly running/managing that source. Hosting, operation and optional professional support cost money. Element also distributes commercial products; buying those is not a prerequisite to using Matrix or self-hosting standalone Synapse. Do not confuse ESS Community's stated non-commercial target audience with a claim that all Matrix software is non-commercial. Record licenses for the exact components/releases chosen. [Synapse repository and licensing](https://github.com/element-hq/synapse), [Matrix ecosystem](https://matrix.org/ecosystem/).

## Option A: maximum messaging reuse (not selected)

- **Homeserver:** unmodified Synapse with its documented database/deployment setup. Reuse Matrix accounts/devices, room membership, event storage, media API, sync and federation capability. Decide whether to enable federation in the first deployment separately from using Matrix.
- **Human client:** a small Aiur-branded Khala application on a supported SDK, using branding from Archon/Aiur. Compare this with an Element customization spike; do not assume an Element fork is cheaper once ongoing upstream merges and the bespoke review UX are included.
- **Browser SDK:** evaluate `matrix-js-sdk` and its maintained crypto integration, using documented initialization/persistence. Do not implement Olm/Megolm/key verification in application code. [JS SDK](https://github.com/matrix-org/matrix-js-sdk).
- **Agent device:** evaluate a TypeScript connector using an existing persistent crypto SDK. The crypto research identifies `matrix-bot-sdk` with native Node crypto bindings as a candidate; verify pinned versions and device-store durability. A native library dependency is not a separately hosted Rust service. Do not assume browser IndexedDB persistence also works in Node; see [E2EE research](05-e2ee.md).
- **Custom Khala components:** human-to-agent ownership binding; connector pending/approved storage and model-access gate; authenticated release/policy records; branded review UI; durable connector inbox and harness adapters; bounded agent loops; product-specific receipts. Avoid a second canonical room transcript.

**Settled product choice: connector-gated approval is sufficient.** If option A wins, use an ordinary Matrix E2EE room; the owner-controlled connector is a trusted room device and may decrypt/store pending content. It releases only human-approved content to the model. This avoids separate cryptographic review rooms and custom group-key choreography. The confidentiality boundary includes the connector and its host. Test that pending content cannot escape through MCP tools/resources, transcript queries, logs, summaries, attachments, notifications or fallback/error paths. Human approval is enforced outside model authority. Separate encrypted review groups are an optional stronger future tier, not an MVP dependency.

## Tickets option A would replace or reduce

| Earlier custom proposal | Option A replacement |
|---|---|
| Custom room log, sequence allocator and generic outbox | Adopt homeserver event persistence and SDK sync; test gaps/pagination and application receipts |
| New WebSocket server and replay protocol | Use Matrix client-server sync; UI freshness comes from the SDK. No custom socket server unless a demonstrated gap requires one |
| Custom room membership/login/device subsystem | Integrate Matrix auth/membership/devices; add only Aiur identity mapping and agent delegation missing from the substrate |
| Custom attachment store protocol | Use encrypted media through SDK/server facilities; prove key/audience and orphan/retention behavior |
| Custom group-crypto implementation | Use SDK-supported Matrix encryption; separately prove connector approval isolation |
| Runtime horse race for the core relay | Deploy/test the existing homeserver first; choose a runtime only for remaining Khala-specific services |

Matrix event IDs are opaque, room history is not Khala's invented contiguous sequence, and sync tokens must be stored/used under the SDK contract. The application still owns release idempotency and external harness uncertainty. Federation is not a globally serial transaction across homeservers; security decisions require supported Matrix state semantics and recipient validation.

## Earlier runtime alternatives, outside the TypeScript/Netlify preference

Archon HEAD `c7d3254` provides working HTTP commands, guarded object writes, scoped realtime credentials, and an SSE hint stream. Aiur HEAD `1f618cddf` provides BEAM supervision, Phoenix channels, projection modules, persistent event journals, and agent control boundaries. Neither repository proves a deployed multi-tenant encrypted Khala relay exists.

| Candidate | Why consider it | Required proof before selection |
|---|---|---|
| Phoenix + Postgres | Aligns with Aiur's Elixir experience; explicit transactions; standard process/container deployment | Atomic log+idempotency+outbox; crash/replay tests; operating cost and backup restore; connector crypto compatibility |
| TypeScript service + Postgres | Shared language with a browser/connector stack; conventional HTTP/socket deployment | Same transaction/replay proofs; bounded fan-out and worker ownership; no dependence on process memory for policy |
| Cloudflare Durable Objects + SQLite | Room coordination and socket hibernation are available managed primitives | Transaction boundaries, hibernation/restart replay, crypto runtime compatibility, cross-object membership operations, export/restore and provider portability |
| Archon-style functions + blob store + broker | Reuses familiar authentication and hosted patterns | Cross-record atomicity and durable ordered feed must be established; whole-transcript CAS and broker retention are insufficient substitutes |

Phoenix Channels do not supply a persistent message queue; keep replay in the authoritative store. Cloudflare documents that hibernation resets in-memory state while keeping supported sockets connected; reconstruct authority from durable state. [Phoenix Channels](https://phoenix.hexdocs.pm/channels.html), [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Do not choose Phoenix solely because Aiur uses it, or Netlify solely because Archon uses it. Choose after deciding whether anyone must self-host the first release. A managed-only prototype and a supported self-hosted product have different installation, migration, monitoring, backup, and upgrade requirements.

## Minimal benchmark and operating evidence

Run matching acceptance/failure workloads against the chosen Matrix integration and bounded Blobs prototype, without building full products for either. Start with two humans and two agents; vary accepted envelope size, offline replay backlog, simultaneous reconnects, and hot-room concurrency. Measure acceptance latency separately from socket propagation and model-start latency. Publish hardware/service settings and the exact sample workload; no invented scale target or free-tier estimate.

Required failures: process exit after commit before fan-out; acknowledgement loss; slow reader; policy/revocation race; backup restore followed by sender retry; storage outage; retention boundary during catch-up. Report whether the system loses an accepted envelope, duplicates a release, or exposes stale authority. Backups restore relay ciphertext and metadata; they do not by themselves restore participant keys or prevent client state rollback.

Operating questions: who hosts relay and connectors; whether each organisation needs its own service; desired data region; retention duration; backup ownership; upgrade downtime; support expectations. These affect the release scope and should be answered before turning recommendations into mandatory architecture.

## Proposed ticket slices

| Slice | Dependencies | Acceptance evidence |
|---|---|---|
| Netlify/Blobs versus Matrix hosting feasibility | Hosting/federation answers, connector approval/identity contract | Two humans/two agents; encrypted history and model-context approval isolation; offline sync, restart/recovery, exact SDK versions; reuse decision |
| Selected substrate integration | Feasibility, identity and crypto contract | Persistent homeserver and SDK stores; restore/retry and limited timeline tests; no second transcript store |
| Self-host packaging, if required | Matrix feasibility, deployment | Fresh install and upgrade/rollback procedure; restore rehearsal; documented secret/key responsibility |
| Optional substrate/bridge feasibility | Explicit integration priority | Approval audiences and disclosure semantics preserved or limitation clearly exposed; no hidden plaintext bridge |
| Operational limits and observability | Selected substrate and connectors | Bounded queues, quotas, ciphertext-safe logs, retention/resync behavior, actionable failure signals |

Detailed task plans follow product decisions and user ticket sign-off.
