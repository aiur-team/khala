---
title: "KHA-115 Persist connector keys and inbox - Plan"
type: feat
date: 2026-09-16
topic: connector-durable-storage
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-115.md
---

# KHA-115 Persist connector keys and inbox - Plan

## Goal Capsule

Preserve the owner connector's encrypted-client state and pending review ledger across restart without skipping messages. Dependencies: KHA-101, KHA-105, KHA-106. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Preserve the owner connector's encrypted-client state and pending review ledger across restart without skipping messages.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Keep crypto state, replay cursors, pending items and releases recoverable under crash and replay.
- R2. Do not assume an atomic transaction spanning an SDK crypto store and application database.
- R3. Protect local secret/plaintext storage and prevent concurrent processes using one device state.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. The connector durably records an event before advancing its application cursor, later records a release and delivery evidence, and recovers safely after a crash.

### Acceptance Examples

- AE1. Crash after pending persistence but before cursor advancement replays harmlessly and preserves one review item. Covers R1 and R2.
- AE2. Missing crypto keys or conflicting event digest causes a visible blocked state, never silent cursor progress or fresh identity substitution. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `packages/connector/src/storage/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-SUBSTRATE and durable headless crypto proof KHA-142 determine SDK storage/replay integration.

### Sources

- `docs/product/tickets/KHA-115.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and durable boundaries

Use the selected SDK's supported durable crypto store plus an owner-local transactional application ledger. KHA-142 must prove a compatible headless TypeScript crypto endpoint. Matrix Rust crypto's internal SQLite and an application SQLite database are separate transactions even if both are SQLite. Do not open, modify or wrap private SDK database tables. A supported SDK store is reused; only the pending/release ledger belongs here.

Proposed files: `packages/connector/src/storage/open.ts`, `ledger.ts`, `leases.ts`, `recovery.ts`, `payloads.ts`, adjacent tests. Export `openConnectorStorage(options): Promise<ConnectorStorage>` and `recoverConnectorStorage(storage): Promise<RecoveryReport>`. Exact maintained SQLite binding and runtime compatibility are pinned through KHA-101 after KHA-142, not silently chosen here.

```ts
type PendingKey = {roomId:string; eventId:string; recipientBindingId:string;
  recipientGeneration:number};
type PersistResult = {kind:"inserted"|"duplicate"} |
  {kind:"conflict";code:"event_digest_mismatch"};
interface ConnectorStorage {
  persistPending(input:{key:PendingKey; event:EventRef;
    plaintext:Uint8Array; receivedAt:string}):Promise<PersistResult>;
  commitCursor(input:{streamId:string; expectedRevision:number;
    opaqueCursor:string}):Promise<{revision:number}>;
  readReleasedPayload(payloadRef:string):Promise<Uint8Array>;
  close():Promise<void>;
}
```

This public seam is intentionally narrow. KHA-119/121 need transaction-scoped ledger operations for approval/release/claim/policy budget; publish those as injected ports matching their contract plans rather than a general SQL escape hatch. Local ledger uniqueness uses room/event/recipient binding/generation, not content digest alone: identical text in distinct events is distinct. Store EventRef, immutable recipient binding/generation and exact bytes together. Recovery to a new generation cannot silently adopt pending approvals/releases; it must preserve old records and require fresh authority according to the approved recovery policy. Test a restored old-generation record against a new binding and reject release. A conflict for the same immutable event identity is quarantined; do not overwrite approved content. Payload handles are random opaque IDs resolved only inside the owner endpoint; no filesystem paths or model-readable URLs.

### Concrete local transaction seam

Export `ConnectorLedger` and `LedgerTx` from `packages/connector/src/storage/ledger.ts` for injected use by121/130/134/135 (119/120 remain pure decision functions with no ledger I/O). Callback transaction is local SQLite application state only; no SDK, network, model submission or async remote effect may occur inside it.

```ts
interface ConnectorLedger {
  transaction<T>(run:(tx:LedgerTx)=>T):Promise<T>;
}
interface LedgerTx {
  readApprovalSnapshot(input:{bindingId:string;selection:readonly EventRef[]}):
    {binding:SessionBinding;policy:EffectivePolicy;
      pending:readonly PendingRecord[];ledgerRevision:number}|null;
  readBinding(bindingId:string):SessionBinding|null;
  readEffectivePolicy(bindingId:string):EffectivePolicy|null;
  readCommand(ownerId:string,commandId:string):CommandRecord|null;
  putRelease(input:{command:CommandRecord; job:ReleasedJob;
    payload:Uint8Array; expectedLedgerRevision:number}):
    {kind:"committed"|"duplicate"}|{kind:"conflict";code:string};
  claimDispatch(input:{releaseId:string;attemptId:string;
    expectedGeneration:number;expectedPolicyVersion:number;
    expectedLedgerRevision:number;budget:BudgetReservation}):
    {kind:"claimed";job:ReleasedJob}|{kind:"blocked";code:string};
  appendReceipt(input:{receipt:DeliveryReceipt;expectedRevision:number}):
    {kind:"recorded"|"duplicate"}|{kind:"conflict";code:string};
  deletePayloadIfUnreferenced(input:{payloadRef:string;
    expectedRevision:number;retentionPolicyVersion:number}):
    {kind:"deleted"|"already_deleted"}|{kind:"deferred";code:string};
}
```

`PendingRecord` pairs immutable EventRef, exact content bytes and recipient binding/generation; readApprovalSnapshot returns one consistent local snapshot for pure119 evaluation, and putRelease compares its ledgerRevision before commit. `EffectivePolicy`, `CommandRecord` and `BudgetReservation` are ledger-local records whose public decision inputs come from106/120/121. CommandRecord stores owner+command ID, canonical input digest and committed result for idempotent replay. BudgetReservation stores trusted causal root, immutable attempt ID and explicit configured allowance/counter revision. `putRelease` rechecks all selection/binding/policy snapshots and writes command outcome, payload and released job atomically or none. `claimDispatch` atomically rechecks effective authority/policy and writes claim, budget reservation and dispatch intent; it never calls the harness. `appendReceipt` validates correlation and preserves incompatible/unknown facts for reconciliation. `deletePayloadIfUnreferenced` checks dispatch/review/recovery references and commits a tombstone in that same transaction. Errors roll back the local transaction; an uncertain commit response requires reopening and reading the original operation identity. These operations make race ownership explicit without exposing raw SQL to consumers. Exact finite error-code unions freeze with106 and the selected policy decisions before implementation; arbitrary exception strings never cross the owner endpoint.

### Replay/crypto crash matrix

| Crash window | Recovery requirement |
|---|---|
| Ciphertext fetched, no durable local observation | SDK/server replay must still retrieve it; do not commit app cursor |
| SDK crypto advances, app pending write absent | Re-delivery/decryption capability must be proven by KHA-142; otherwise durably stage ciphertext before the destructive SDK boundary using a supported hook |
| Pending record committed, app cursor absent | Replay deduplicates by immutable identity and verifies digest |
| Cursor commit reports error/unknown | Reload durable revision; never advance in-memory authority optimistically |
| Release exists, external harness acceptance unknown | Keep unknown; storage recovery cannot authorize automatic resubmission |

Staging ciphertext is not by itself sufficient: if the SDK cannot decrypt a replay after ratchet advancement, a ciphertext spool does not restore missing plaintext. Require an experimentally demonstrated recoverable ingestion boundary or declare that SDK path unsupported. No atomicity claim across SDK crypto and app ledger. A server sync token is opaque; transactionally commit app pending records plus its own app cursor only when the actual adapter guarantees events are recoverable.

### Local protection and locking

Create state directory owner-only (0700 where supported) and sensitive files0600; reject unexpected symlinks/untrusted state paths. Use OS-backed exclusive process lock and durable generation/fencing for mutating ledger operations. SDK one-device state must not be shared by concurrent processes. File modes protect ordinary local users, not a same-user unrestricted model tool; record this threat limit and prefer a separate privilege boundary when the runtime provides one. Logs never include payloads, keys or bearer tokens. Encryption at rest follows proven SDK/application facilities and recovery decisions; do not claim filesystem deletion is secure erasure.

## Implementation Units

### U1. Open, migrate and exclusively own the store

Implement path validation, permissions, schema version check, lock acquisition and clean close. Concurrent opener fails visibly. Crash-recovered stale locks must use OS/process validity rather than trusting old PID text. Tests corrupt schema, unsupported downgrade, unwritable disk, second process and symlink path. Covers R3.

### U2. Pending payload and replay ledger

Depends U1. Implement unique event/recipient identity, immutable digest checks, opaque payload references and cursor compare-and-set. Test duplicate event, changed digest, failed write, crash-before-cursor and uncertain cursor acknowledgement. Covers R1 and AE1.

### U3. SDK/app crash recovery proof

Depends U2 and KHA-142 durable crypto result. Fault-inject at each matrix boundary with the pinned real SDK/store. Record which SDK recovery primitive prevents data loss; if none exists, block KHA-116/133 rather than coding an unsupported transaction assumption. Covers R2/AE2.

### U4. Release/claim port integration fixtures

Depends U2. Provide transaction-scoped fake and real ledger conformance for KHA-119/120/121. KHA-133 wires real consumers. KHA-130 owns retention, so expose reference enumeration/claim fences without implementing deletion policy here. Migration and crash tests must run against actual disk, not only in-memory maps.

## Verification Contract

Run `pnpm --filter @khala/connector test` and `pnpm typecheck` after scaffold; include spawned-process lock/crash tests and filesystem fault injection. KHA-142 pins the native runtime/SDK combination. Kill-after-write tests inspect reopened on-disk state and replay result. Planning performed no database/crypto experiments; this section defines required evidence, not passed tests.

## Definition of Done

No loss across every supported crash window, no duplicate review record, no concurrent device-state writers and no false delivery success. Every invariant has a real-store test; unsupported SDK boundaries are documented blockers. Readiness requires chosen substrate/durable crypto mechanism and its proven recovery boundary.
