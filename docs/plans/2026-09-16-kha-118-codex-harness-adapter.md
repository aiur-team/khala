---
title: "KHA-118 Adapt Codex existing-session delivery - Plan"
type: feat
date: 2026-09-16
topic: codex-harness-adapter
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-118.md
---

# KHA-118 Adapt Codex existing-session delivery - Plan

## Goal Capsule

Implement only the Codex route that KHA-104 proves can reach the current working session. Dependencies: KHA-101, KHA-106. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Implement only the Codex route that KHA-104 proves can reach the current working session.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Keep immutable thread/session binding and use a version-validated native submission surface.
- R2. Separate busy handling from idle submission and reject stale turn/session identifiers safely.
- R3. Preserve uncertainty after possible external acceptance; never equate a turn API response with task completion.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. The runtime supplies a release and exact thread binding; the adapter invokes the proven queue/proxy/app-server route and reconciles correlated status.

### Acceptance Examples

- AE1. The same release ID cannot create two turns through routine retry. Covers R1 and R2.
- AE2. A lost response after possible enqueue becomes outcome_unknown until correlated evidence resolves it. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `packages/harnesses/src/codex/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-HARNESSES; KHA-104 selects the compatible route and establishes its exact request schema.

### Sources

- `docs/product/tickets/KHA-118.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and route gate

Use the route and exact schema evidenced by KHA-104; export `createCodexHarness(deps): HarnessPort` from `packages/harnesses/src/codex/index.ts`. Files `capabilities.ts`, `transport.ts`, `receipts.ts`, `reconcile.ts` and adjacent tests stay in this directory. Import the KHA-106 contract, no local substitute for ReleasedJob/SessionBinding/DeliveryReceipt. The adapter depends only on its native client/transport port and injected clock/evidence store/release-codec port; KHA-133 supplies composition.

The installed CLI's `queue` and app-server/proxy surfaces are candidates, not interchangeable attachment APIs. KHA-104 must establish which reaches the existing TUI/thread and pin its schema. App-server `thread/resume` must not create a second executing owner of an already-running thread. Busy turn steering requires the correct current turn identity and supported behavior; a stale turn identifier is a visible conflict, not permission to start a new turn automatically.

### Input, authority and byte handling

`inspect(binding)` verifies native session existence, ownership/transport authentication, installed version and proof-compatible route. Unsupported versions are reported experimental or unsupported, never promoted by semver alone. `submit({job,payload})` validates binding ID/generation and payload digest, verifies every approved event reference through the released envelope codec, then sends only the released payload. Agent/tool output is untrusted message data, not control authority. Do not prepend pending sender names, previews or queue contents. Owner credentials never enter the harness transport.

Local transport must be bound to the intended owner process and narrow local endpoint; use native authenticated mechanisms. Do not expose an unauthenticated WebSocket/HTTP listener on all interfaces for convenience. Process arguments and diagnostics must not contain plaintext payloads/tokens. A structured stream or protected local IPC transport is preferred when the proven route supports it; if the only usable interface leaks content via argv, record the limitation and resolve it before shipping.

### Worked lifecycle and uncertain outcome

Release `rel-b-7` targets `bind-b-1`, generation0, existing session `session-b`. Adapter inspection confirms the native session. A local write completes; emit `transport_written` only if that fact is observed. If an authenticated native response correlates `rel-b-7` to its queue item/turn, emit `harness_queued`. Consumption/completion observations remain independently evidenced. If the client disconnects after possible acceptance, return `outcome_unknown`. `reconcile(job)` queries native correlated status only when the proof established it; absence of a status capability returns null and does not authorize another submit.

The adapter does not implement the durable exactly-once ledger: KHA-121 claims jobs and prevents routine repeat submission; KHA-115 stores evidence. A process restart must not treat a lost in-memory dedup map as permission to send again. A second legitimate release of identical text has a distinct ID and remains a separate decision. Cancellation is not advertised unless native semantics are proven; a requested cancel cannot erase an already-consumed prompt.

## Implementation Units

### U1. Capability probe and safe endpoint selection

Read KHA-104 evidence and pin version/schema fixtures. Implement `inspect` and endpoint/session validation. Covers R1. Test absent session, permission mismatch, unsupported version and stale binding generation. No runtime code route may be selected solely from an unverified documentation example.

### U2. Released byte submission

Depends U1. Implement native encoding and transport using exact source schema. Covers R1/R2 and AE1. Test digest mismatch, changed binding, unapproved data inclusion, unauthenticated endpoint and malformed native response. A submission call is issued once per dispatch attempt; `notify` must not itself cause a duplicate model prompt.

### U3. Receipt mapping and reconciliation

Depends U2. Map native events to KHA-106 evidence with stable IDs. Covers R2/R3 and AE2. Test lost response, duplicate/out-of-order receipts, busy response, session exit, reconnect and unsupported reconciliation. No inferred consumption from socket write or token usage counter.

### U4. Conformance and composition handoff

Run KHA-137 neutral harness tests with this adapter and its supported native environment. KHA-133 binds it into runtime. Publish an explicit support row naming harness, exact version, provider restrictions, route, required agent setup, busy behavior and observable receipts. A mock-only pass remains component evidence.

## Verification Contract

After KHA-101 run `pnpm --filter @khala/harnesses test` and `pnpm typecheck`. Contract fixtures test all failure branches, plus a disposable live same-session integration using KHA-104's evidence recipe. Test process-argument/log capture for plaintext leakage. Strong receipt assertions require native evidence, not a fake configured to return success. No live adapter or message send was run during planning.

## Definition of Done

R1–R3/AE1–AE2 pass on the documented supported route; no replacement session, privilege expansion or pending plaintext delivery occurs. Reconciliation and unknown outcomes remain honest across restart. G-HARNESSES and KHA-104 proof must clear before implementation-ready status; a failed proof blocks this production adapter rather than changing the product contract.
