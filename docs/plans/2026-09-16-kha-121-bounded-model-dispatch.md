---
title: "KHA-121 Dispatch released messages within controls - Plan"
type: feat
date: 2026-09-16
topic: bounded-model-dispatch
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-121.md
---

# KHA-121 Dispatch released messages within controls - Plan

## Goal Capsule

Move approved jobs into the bound session while respecting effective human controls and finite automation limits. Dependencies: KHA-101, KHA-105, KHA-106. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Move approved jobs into the bound session while respecting effective human controls and finite automation limits.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Recheck effective policy, session generation and revocation immediately before dispatch.
- R2. Persist claim and budget reservation before external submission; correlate all evidence with one release identity.
- R3. Stop automatic retry when external acceptance is ambiguous and prevent recursive agent conversations from evading configured budgets.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. A released job enters the local queue, is claimed under current effective controls, consumes its configured allowance, and receives evidence or an explicit unknown outcome.

### Acceptance Examples

- AE1. A pause acknowledged before the dispatch linearization point blocks a queued job. Covers R1 and R2.
- AE2. A crash after possible external acceptance does not automatically resubmit the job after restart. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `packages/connector/src/dispatch/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-AUTOMATION: human-approved budget units/limits, pause scope and busy policy are required before launch; fixtures use explicit test configuration only.

### Sources

- `docs/product/tickets/KHA-121.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and linearization

Export `createDispatcher(deps): Dispatcher` from `packages/connector/src/dispatch/index.ts`. Own `claim.ts`, `budget.ts`, `run.ts`, `reconcile.ts` and adjacent tests. Dependencies are KHA-106 HarnessPort plus injected local ledger/policy/clock/release-codec ports, not imports of unfinished storage/policy implementations. KHA-133 wires actual instances; KHA-135 wires human controls. The ledger performs one local transaction for eligibility check, claim, budget reservation and dispatch intent. It cannot include the external harness operation.

```ts
type DispatchPolicy = {version:number; paused:boolean;
  maxJobsPerCausalRoot:number; maxConcurrentJobs:number;
  expiresAt:string|null; busy:"queue"|"wait"|"reject"};
interface Dispatcher {
  wake():void;
  reconcile(releaseId:string):Promise<void>;
  stop():Promise<void>;
}
type ClaimResult = {kind:"claimed"; attemptId:string; job:ReleasedJob} |
  {kind:"blocked";code:"paused"|"budget_exhausted"|"stale_binding"|
    "stale_policy"|"revoked"|"busy"|"expired"|"claimed_elsewhere"};
```

Policy shape is a candidate implementation configuration, not approved product defaults. G-AUTOMATION must decide limits, budget scope/unit, reset ownership and busy behavior. Fixtures explicitly set a finite job count/concurrency value; absence of launch configuration blocks automatic dispatch. Token cost cannot be guaranteed for arbitrary harnesses without a reliable native enforcement mechanism. Never label a job-count cap a spend cap.

### State/effect ordering

1. Read a durable released job, verify owner binding/generation and payload digest against KHA-119 codec.
2. In a single local transaction recheck effective policy/revocation, compare expected revisions, reserve budget and persist dispatch intent with stable attempt ID.
3. Immediately execute the eligible native submission; record each observed receipt durably. A pause effective before step2 blocks the job. After step2 the UI must show that in-flight work may proceed; no retroactive cancellation promise.
4. If the process crashes or a response is lost after intent persistence, reopen as outcome_unknown until correlated native evidence or an explicit authorized resolution establishes safe action. Do not automatically return it to queued.

A claim lease/fencing token prevents concurrent local workers from claiming the same job; it does not prevent a paused old process from later submitting after lease expiry. Therefore an expired dispatch-intent claim is not automatically re-submitted by another worker. Resolve owner-process liveness and native acceptance first. Control ack becomes effective only when the connector has applied it at the documented dispatch boundary; cloud CAS success alone is `pending`.

### Worked budget/loop case

A→B release starts causal root `cause-1`; B's reply and A's subsequent reply retain that root through trusted connector metadata. With explicit test policy maxJobsPerCausalRoot=2, the third attempted dispatch is blocked. Model-authored metadata cannot reset counters or choose a fresh trusted root. Human initiation/reset permissions are unresolved G-AUTOMATION choices, not an agent escape route. Maintain ledger counters transactionally; duplicate wakeups do not consume multiple reservations for the same attempt. A definitive pre-send rejection may release a reservation under policy; an unknown acceptance must not refund it automatically.

### Failure matrix

| Situation | Required result |
|---|---|
| Owner re-arms review before eligibility claim | Old auto-release invalidated/revalidated under current policy; no send |
| Pause reaches cloud while connector offline | Requested state shown; effective version unchanged |
| Changed payload at local handle | Digest mismatch; quarantine and no submit |
| Harness queue accepts, response lost | Unknown; reconciliation without blind resend |
| Busy route cannot queue | Wait/reject according to explicit policy; no replacement turn |
| Device/session revoked | Stop new claims; document in-flight limit |

## Implementation Units

### U1. Eligibility and transactional claim

Implement claim semantics against an injected transaction ledger. Covers R1/R2 and AE1. Tests simultaneous workers, stale generation, changed policy, revoked device, missing budget configuration and expired job. Do not depend on multi-key hosted Blobs atomicity for this local transaction.

### U2. Budget and causal accounting

Depends U1. Implement explicit configured finite limits and trusted causal propagation. Covers R3. Tests duplicate wake, two concurrent reservations at last allowance, forged root reset, unknown-outcome non-refund and reset-authority policy once decided.

### U3. Submission and receipt persistence

Depends U1/U2. Validate exact payload then invoke HarnessPort once, persist independent evidence and unknown state. Covers R2/R3 and AE2. Fault-inject before intent, after intent before call, after call before receipt and during receipt commit. Conservative unknown before a confirmed no-send can reduce liveness; this is intentional until a safe reconciliation proves otherwise.

### U4. Restart and controls integration

Reconcile unresolved intents using native support, never assume timeout means failure. KHA-133 binds ledger/subscription/harness; KHA-135 binds pause/budget status. KHA-137 executes neutral fault scenarios. Publish the effective-control linearization point and in-flight limit for UI copy.

## Verification Contract

Run `pnpm --filter @khala/connector test`, `pnpm typecheck` after scaffold. Use fake clocks and two concurrent dispatcher instances against the same real local ledger for claims/budget tests; inject crash hooks around every boundary. Assert no second submit when first outcome is unknown. Live native reconciliation evidence belongs to KHA-103/104/117/118/133; no dispatch occurred during planning.

## Definition of Done

No unapproved/stale-bound payload submitted, finite configured controls enforced, ambiguous external outcomes preserved without automatic replay, and pause timing documented/tested. G-AUTOMATION must settle budgets/busy/reset semantics; otherwise keep this checkpoint non-ready rather than choosing defaults.
