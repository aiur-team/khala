---
title: "KHA-130 Apply approved connector retention - Plan"
type: feat
date: 2026-09-16
topic: connector-retention-cleanup
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-130.md
---

# KHA-130 Apply approved connector retention - Plan

## Goal Capsule

Delete local content according to the agreed history policy while preserving security and delivery invariants. Dependencies: KHA-101, KHA-105, KHA-106. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Delete local content according to the agreed history policy while preserving security and delivery invariants.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Apply only an explicit retention/recovery policy; do not invent a default TTL.
- R2. Coordinate cleanup with pending approvals, active dispatch and recovery so deletion never implies successful delivery.
- R3. Distinguish local cleanup from remote copies, SDK key backup and storage-level secure erasure.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. A maintenance sweep evaluates eligible records against policy and active references, deletes permitted content idempotently, and records minimal non-content evidence.

### Acceptance Examples

- AE1. An interrupted sweep resumes without deleting a payload held by an active dispatch claim. Covers R1 and R2.
- AE2. Deleting pending content invalidates stale approval references explicitly rather than approving an empty replacement. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `packages/connector/src/retention/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-RETENTION: history, pending expiry, recovery, attachments and deletion/tombstone horizons must be decided.

### Sources

- `docs/product/tickets/KHA-130.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and policy gate

Export `sweepRetention(input, ports): Promise<RetentionReport>` from `packages/connector/src/retention/index.ts`. Own `eligibility.ts`, `sweep.ts`, `report.ts` and adjacent tests. Retention is an explicit owner/product policy consumed from the approved control contract. G-RETENTION must decide pending expiry, approved history, attachment handling, backup scope, recovery guarantees and tombstone/dedup horizon. No default numeric TTL is selected by this plan.

```ts
type RetentionPolicy = {version:number; evaluatedAt:string;
  pendingBefore:string|null; releasedBefore:string|null;
  allowPendingDeletion:boolean; dedupBefore:string|null};
type RetentionReport = {policyVersion:number; examined:number;
  deleted:number; deferred:number; failed:number;
  reasons:Readonly<Record<string,number>>};
interface RetentionPorts {
  records:RetentionRecordPort; claims:ActiveClaimPort;
  crypto:SupportedCryptoMaintenancePort; clock:Clock;
}
```

These are local dependency seams, not new public APIs. KHA-105/106 remain authoritative for identity/events/jobs; KHA-115 owns transactional record operations. Counts are owner-UI/operations data, never model-facing pending hints. SDK maintenance is limited to documented APIs; never delete ratchet/session tables directly to satisfy an application TTL. Cryptographic key deletion, provider backups and remote ciphertext retention are separately scoped by the actual product policy.

### Worked deletion race

Pending event E7 has been displayed for review. A sweep marks its payload eligible while an approval arrives. The application ledger transaction compares payload revision, current policy and active references; exactly one operation wins. If approval/release wins, deletion defers while the release/dispatch owns the bytes. If deletion wins, approval returns explicit expired/unavailable content and cannot authorize replacement bytes. A sweeper lease alone does not close this race; the same local transaction must validate references and invalidate/delete the payload.

Never delete a receipt/dedup tombstone merely because payload retention elapsed if replay can recreate the old event as new. Tombstone lifetime is bounded by the selected substrate replay/history horizon and product policy; if no finite safe horizon exists, require a retained minimal non-content identity or explicitly support replay suppression through another proven mechanism. Do not silently retain forever as a product decision. Unknown external outcomes retain enough evidence to avoid automatic duplicate dispatch even if content is removed under approved policy.

### Failure and recovery rules

Interrupted batches resume idempotently with a sweep cursor; cursor advance follows confirmed per-record result. Disk failure returns partial report and never claims whole-sweep success. Missing payload must become a visible tombstone/state, not a successful zero-length message. Local deletion cannot erase previously released model context, another participant's copy, SSD remnants or provider backups. Reports disclose these limits without broadening cleanup into remote deletion features.

## Implementation Units

### U1. Approved eligibility predicate

Encode explicit retention policy and record/reference facts as a pure decision function. Covers R1/R2. Test boundary timestamps, clock skew, absent policy, pending vs released state, backup dependencies and unknown dispatch status. Undecided policy fields block affected cleanup.

### U2. Transactional deletion and invalidation

Depends U1 and KHA-115 ledger. Implement bounded batches and reference-aware compare-and-set deletion. Covers R2 and AE1/AE2. Test approval-vs-delete, dispatch claim-vs-delete, retry after crash and tombstone replay prevention.

### U3. SDK-safe maintenance and owner report

Depends U2. Invoke only proven SDK maintenance facilities, report per-class failures and recovery limits. Covers R3. KHA-133 schedules the sweep through explicit runtime wiring; this component does not start a daemon or invent browser-closed operation. KHA-136 recovery consumes the approved deletion implications.

## Verification Contract

After scaffold run `pnpm --filter @khala/connector test` and `pnpm typecheck`. Use fake clock for eligibility and real local ledger concurrency tests for deletion races. Assert deleted bytes cannot be returned from application payload handles while receipts remain honest; do not claim forensic secure erase from that test. No cleanup operation ran during planning.

## Definition of Done

Approved policy drives every deletion; active claims and stale approvals behave deterministically; replay cannot resurrect expired content as a new review item unnoticed. UI/report wording distinguishes local cleanup from global erasure. G-RETENTION is resolved and recovery owner agrees before ready status.
