# Hosting and reuse: Matrix on Railway versus Netlify-native

Decision brief, 2026-09-16. **Recommendation: validate Synapse on Railway, with the TypeScript Khala web app on Netlify and TypeScript connectors on the owners' machines.** This is a recommendation for product/technical selection, not an approved deployment. No resources have been provisioned or paid services purchased.

The user's priorities are TypeScript application code, maximum off-the-shelf OSS reuse, connector-gated review, existing-session agent attachment, and timely model-independent notifications. Netlify Functions/Blobs are preferred; a Railway backend is acceptable if it materially reduces development.

## What each option actually deploys

| | A: Matrix on Railway + Khala on Netlify | B: Netlify-native Khala |
|---|---|---|
| Human application | Aiur-branded TypeScript web app on Netlify; compare thin Element adaptation with SDK-based UI | Aiur-branded TypeScript web app on Netlify |
| Messaging backend | Existing Synapse container, PostgreSQL and persistent media/config storage on Railway | Our TypeScript Functions, encrypted message/state objects in Blobs |
| Encryption | Existing Matrix SDK crypto and device lifecycle | Selected OSS E2EE engine plus application-owned device/group lifecycle integration |
| Realtime | SDK sync against the homeserver | External realtime broker, or a separately proven serverless streaming approach |
| Agent side | Owner's TypeScript connector: decrypt, review gate, subscribe, wake existing session | Same owner-side responsibilities, using our message protocol |
| Khala-specific control state | Connector-local durable state; minimal Netlify functions/state only where needed | Connector-local state plus Netlify policy/invitation/message state |
| Separate custom Hono daemon | Not needed by this architecture | Not needed if Functions plus external realtime meet requirements |
| Canonical channel history | Matrix | Khala's Blobs-backed message model |

Matrix is a protocol; Synapse is its established Python/Rust server implementation. It is an external dependency rather than TypeScript application code we maintain. Synapse's installation documentation provides container deployment and recommends Postgres for production. [Synapse source](https://github.com/element-hq/synapse), [installation](https://element-hq.github.io/synapse/latest/setup/installation.html), [Postgres guidance](https://element-hq.github.io/synapse/latest/postgres.html).

Railway supports Docker-based services, persistent volumes and a deployable Postgres service. That supports the proposed topology, but this combination has not yet been deployed or load-tested for Khala. Railway's Postgres documentation calls its templates unmanaged: maintenance and restore verification remain our responsibility. [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [volumes](https://docs.railway.com/volumes), [Postgres](https://docs.railway.com/databases/postgresql).

## A: Matrix on Railway

### Pros

- **Largest reduction in messaging implementation.** Reuse room membership, event history, sync, device identities, encrypted event handling and SDK recovery machinery. We integrate established semantics instead of defining and maintaining each one ourselves. Matrix's [client-server specification](https://spec.matrix.org/latest/client-server-api/) is the source for those facilities.
- **Keeps Khala code focused on the product.** The airlock, human-agent attribution, existing-session adapters and Aiur-branded workflow are the valuable custom pieces in either design.
- **TypeScript still fits our code.** Browser and Node SDK candidates exist. A TypeScript bot SDK with native crypto bindings offers a durable connector path to validate; we need not author a Python service. See [the crypto comparison](05-e2ee.md).
- **Netlify still hosts the UI.** Hosting Synapse elsewhere does not force the web app, public site or small control functions off Netlify.
- **No mandatory new WebSocket implementation.** Matrix SDK sync supplies room updates; our agent connector translates those updates into the active harness's notification mechanism.
- **Existing tools can help debug and test.** An ordinary Matrix client can participate in encrypted-room interoperability tests. Federation is available later if selected, without designing a new server federation protocol.
- **Portable infrastructure.** Synapse and Postgres can run elsewhere if Railway no longer fits; the homeserver does not depend on a proprietary message-store format owned by Khala.

### Cons

- **We operate a real persistent backend.** Plan for server upgrades, database/media backups, monitoring, storage growth, security patches and restore tests. Railway simplifies deployment; it does not make Synapse a maintenance-free managed messaging product.
- **Additional ongoing cost.** The homeserver, database, storage and network traffic have costs even when the product is quiet. No cost estimate is justified yet; measure a representative small deployment and check current service billing.
- **Matrix's model becomes part of ours.** Account/device verification, rooms, event relations, key recovery and history semantics influence onboarding and support. Friendly Khala screens must not hide a necessary security step or misrepresent sync state.
- **Agent crypto requires validation.** Persistent headless keys, device verification, restarts and current SDK/native-binding compatibility must work together. “Supports Matrix bots” is not sufficient evidence of durable encrypted-room support.
- **UI reuse has limits.** Element can save common chat/device flows, but extensive changes may create a costly fork. Test the airlock and ownership UI in a thin adaptation before committing to it. A maintained SDK-based UI is the fallback.
- **Does not solve existing-session delivery.** Matrix can notify the connector; attaching a message to a busy Claude/Codex/other session is still a harness adapter responsibility.
- **Not every byte of the system is TypeScript.** Our app and connector can be TypeScript; Synapse and its database are deployed OSS dependencies. If “TypeScript stack” means every server process must be TypeScript, this option does not meet that interpretation.

## B: Netlify Functions + Blobs + reusable crypto/realtime

### Pros

- **Closest to the preferred deployment model.** Application endpoints and state live alongside the web app; no Synapse process or Postgres service to operate.
- **Strong local reference.** Archon already demonstrates scoped credentials, guarded Blobs updates, ambiguous-write recovery and Ably realtime hints. We have inspected code and tests rather than only a diagram.
- **Direct control of Khala semantics.** Invitations, review queues and human-agent identity can be designed without mapping every interaction into Matrix rooms/events.
- **Potentially attractive for intermittent use.** Functions and object storage align with sporadic small-room activity. Actual cost depends on calls, fan-out, storage, broker charges and traffic; it is not established as cheaper.
- **TypeScript application code throughout.** Client crypto may still use a vetted native/WASM core, but our backend remains TypeScript functions.

### Cons

- **Substantially more product infrastructure to build.** We own message acceptance, ordering/history, replay, membership, idempotency, recovery and compatibility rather than adapting an existing messaging system. These remain custom work even if the encryption primitives come from a library.
- **Group E2EE is more than encryption/decryption.** Devices, verification, key distribution, membership changes, durable crypto state, history disclosure and recovery all need application integration and tests. A small AES wrapper is not an equivalent replacement for Matrix's client stack.
- **Blobs needs an intentionally constrained state design.** It supports conditional writes and strong reads, but has no documented multi-object transaction. Related changes must be co-located or reconciled; large rooms cannot casually rewrite an ever-growing transcript blob. [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).
- **Immediate pub/sub still needs a transport.** Blobs is storage, not a subscription service. Bounded serverless execution does not create a durable background listener. A broker can remove socket-server operations, but adds a service dependency and usually is not itself an OSS deployment. [Functions overview](https://docs.netlify.com/build/functions/overview/).
- **More failure behavior belongs to us.** A stored message whose publish fails, a retried approval, a stale policy, and a connector that crashes between decrypt and delivery each need explicit handling. Archon's optional hint stream is helpful reference, not complete channel delivery semantics.
- **No established-client fallback.** Generic Matrix clients can diagnose a Matrix room; our custom encrypted protocol initially has only our own clients and tests.

## What both options still need

1. Owner-controlled TypeScript connector installed or started by the existing working agent.
2. Separate human approval authority, a durable pending/approved inbox and visible trust mode.
3. A common adapter interface with harness-specific notifications into the same session. “Any model” means no vendor restriction in the protocol; it cannot imply every harness exposes the same live injection API.
4. Clear behaviour when the agent is busy, the owner's machine sleeps, a subscription expires, or delivery outcome is unknown.
5. Bounded automatic replies, pause/re-arm controls and restart-safe consumption tracking.
6. Aiur branding, invitation/preview UI, accurate identity and delivery status, and an end-to-end four-actor proof.

Neither option requires Khala to host model inference. Neither can keep an agent on a sleeping laptop actively working. Neither removes the model-provider disclosure that happens after approved content enters an agent.

## Development savings assessment

Matrix is likely to save substantial development **if the encrypted headless connector and UI integration work with supported components**. The saving comes from not owning a new messaging substrate and client crypto lifecycle. This is an engineering assessment based on the facilities available, not a measured percentage or calendar estimate.

Railway by itself does not save that implementation work. Hosting a new Hono service there would still leave us designing channel messaging, crypto integration and recovery. The useful combination is Railway running an existing backend such as Synapse.

Blobs remains useful for small Khala-specific metadata where needed, but duplicating the Matrix transcript or treating Blobs and Matrix as two competing authorities would erase much of the benefit. Keep one owner for each state category.

## Recommended decision experiment

Before freezing the ticket plan, validate:

- An encrypted room with two human devices and two TypeScript connectors using pinned supported SDKs.
- Connector crypto state survives restart and device verification/key access remain functional.
- Pending messages reach the human preview but no unapproved message reaches the model adapter.
- A released message notifies the actual existing Claude and Codex sessions on recorded harness/protocol versions. Prove idle reaction and busy enqueue separately; report required opt-in and unsupported policy clearly. Do not equate notification submission with model consumption. Other harnesses implement the same documented adapter contract.
- A thin branded client can support the review controls without maintaining a deep Element fork.
- A reproducible Synapse/Postgres deployment on Railway, including persistent storage, restart and restore, has acceptable measured operation and cost. Provisioning itself remains a later explicit action.

If these pass, choose Matrix on Railway with the web experience on Netlify. If an essential integration fails, record the precise failure and compare fixing that integration against the larger Netlify-native build. Do not abandon established messaging merely because the initial SDK setup is unfamiliar, and do not force Matrix through a product requirement it cannot meet.
