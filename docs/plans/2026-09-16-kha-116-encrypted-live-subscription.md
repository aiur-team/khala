---
title: "KHA-116 Subscribe to encrypted chat events - Plan"
type: feat
date: 2026-09-16
topic: encrypted-live-subscription
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-116.md
---

# KHA-116 Subscribe to encrypted chat events - Plan

## Goal Capsule

Keep an attached owner connector aware of chat events through live subscription plus durable catch-up. Dependencies: KHA-101, KHA-105, KHA-106. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Keep an attached owner connector aware of chat events through live subscription plus durable catch-up.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Use the selected OSS transport/crypto SDK for encrypted room sync and decryption.
- R2. Deduplicate replay and recover reconnect gaps before advertising caught-up status.
- R3. Withhold all pending message text from model-facing notifications and preserve sleep/offline visibility.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. The connector loads its committed cursor, subscribes, ingests recoverable events, and advances only after durable handling; reconnect resumes catch-up.

### Acceptance Examples

- AE1. A disconnect covering two events yields each review item once after recovery. Covers R1 and R2.
- AE2. A delayed decrypt remains blocked/retryable and cannot disappear behind an advanced cursor. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `packages/connector/src/subscription/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-SUBSTRATE and its SDK-specific replay semantics must be validated before selecting the adapter.

### Sources

- `docs/product/tickets/KHA-116.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and transport reuse

Export `startSubscription(input, ports): Promise<SubscriptionHandle>` from `packages/connector/src/subscription/index.ts`. Put SDK-specific adapter in `adapter.ts`, deterministic ingestion in `ingest.ts`, readiness/reconnect state in `state.ts`; adjacent tests use injected sources and storage. Use selected OSS sync APIs, not a new WebSocket protocol. Matrix candidate uses its SDK's sync/sync-token semantics; Netlify-native candidate needs a selected durable event source plus external live hint mechanism. Netlify function invocation lifetime is not a persistent connector runtime.

```ts
type SubscriptionState =
  | {kind:"starting"|"catching_up"|"live"; streamId:string}
  | {kind:"blocked"; code:"missing_keys"|"storage_failed"|
      "authority_lost"|"replay_gap"|"unsupported"}
  | {kind:"offline"; retryAt:string|null};
interface SubscriptionHandle {
  state():SubscriptionState;
  stop():Promise<void>;
}
interface EventIngestionPort {
  accept(input:{binding:SessionBinding; event:EventRef;
    canonicalPayload:Uint8Array}):Promise<"stored"|"duplicate"|"blocked">;
}
```

Sources/cursors are adapter-private opaque values; do not expose numeric sequence assumptions through a Matrix adapter. `accept` can produce pending review state only, never a model notification. The dispatch component later notifies released work. Human review UI updates travel through the authorized owner UI path; generic logs/status expose readiness only, not pending text/count/sender details to model tools.

### Subscribe/replay handoff and worked reconnect

At start, acquire the device lock through KHA-115, load durable source cursor, attach live reception and catch up through the SDK's defined boundary. For a stream with separate journal and live hints, subscribe first and replay with dedup; the subscription hint is only a wakeup to read durable events. Aiur `executor_events.ex` uses journal replay plus subscription/cursor dedup as the reference pattern; its ETS exchange alone is ephemeral and cannot substitute for a durable log. Archon realtime/SSE code supplies refresh hints and generation guards, not message delivery guarantees.

Example: cursor C7 is committed; event E8 arrives and pending write completes, then connection drops before C8 commit. Reconnect from C7 yields E8/E9. E8 verifies identical digest and does not create another pending item; E9 persists before cursor C9 can become committed. A stale old connection callback arriving after reconnect carries an old local generation and is ignored. Never call a source token lexicographically greater/newer. If source retention made replay impossible, emit replay_gap and require recovery; do not label live and silently skip.

Decryption may need room keys arriving later. Persist recoverable ciphertext through a supported adapter boundary, keep an explicit blocked/retryable event and do not advance beyond an unrecoverable hole. KHA-115/142 must prove SDK crypto/application durability together. Stop/drop behavior on revocation is immediate locally once effective; reconnection rechecks authority rather than trusting cached membership forever.

### Backpressure and lifecycle

Bound in-flight decryption/storage work and buffered hints; coalesce hints only when durable replay covers their events. Do not drop unique events to meet a memory cap. When storage is unavailable, stop advancing and advertise blocked. Retry transport outages with bounded exponential backoff/jitter and cancellation; refresh expiry under the chosen SDK. Backoff constants are implementation reliability settings, not user automation budgets. Browser closure does not imply connector survival; P02/runtime evidence controls that claim.

## Implementation Units

### U1. State machine and source interface

Define readiness transitions, local subscription generation, cancellation and opaque cursor adapter contract. Cover R1/R2. Test old callback, restart, cancellation and unsupported source. Reuse KHA-105/106 identifiers, no parallel EventRef.

### U2. Durable ingestion and dedup

Depends U1 and KHA-115 interfaces. Validate author/device provenance and immutable digest; persist before cursor acknowledgement. Covers R2 and AE1. Test E8/E9 sequence, same ID changed content, storage failure and delayed keys. The crypto SDK verifies its envelope; application provenance still maps verified device to participant.

### U3. Reconnect, authority and bounded work

Depends U2. Add live SDK adapter, reconnect/catchup barrier, revoked/expired credential handling and queue pressure. Covers R1/R3 and AE2. Test multiple disconnect points, source retention gap, key arrival after event and revoked device while offline.

### U4. Composition handoff

KHA-133 wires subscription state to runtime and storage lock. KHA-137 consumes fault hooks. Publish source-specific recovery evidence with selected SDK versions; no live-transport readiness claim from fake source tests.

## Verification Contract

Run `pnpm --filter @khala/connector test`, `pnpm typecheck`; fake-clock tests cover bounded retry/cancellation and deterministic replay. With the selected substrate, run integration reconnect and delayed-key cases through KHA-133. Test spies assert model-facing ports receive zero pending content or notification before release. No live subscription was established during planning.

## Definition of Done

AE1/AE2 and all transitions verified, cursor movement backed by durable recoverability, no pending plaintext/hints reach model ports, and SDK-specific replay gaps are explicit. G-SUBSTRATE plus KHA-115/142 crypto-crash findings must clear before implementation-ready designation.
