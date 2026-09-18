# `@khala/connector/dispatch`

Bounded model dispatch (KHA-121). `createDispatcher(deps)` moves released jobs into their
bound session through the KHA-106 `HarnessPort`, within the effective human controls and
finite automation limits. Every effect goes through an injected port, so this module imports
no storage, policy, SDK or harness implementation. KHA-133 binds the durable ledger,
subscription and harness; KHA-135 binds pause and budget status.

| Port | Responsibility |
|---|---|
| `DispatchLedger` | One local transaction at a time: each binding's effective policy, binding state, dispatch records and causal counters. Must be serializable across processes. Work runs synchronously; a throw rolls it back. No external effect runs inside it |
| `HarnessPort` (contract) | `inspect`, `submit`, `reconcile` for the bound session |
| `approvals` | The approval a release names, from the owner connector's own ledger |
| `payloads` | Owner-local payload bytes by `payloadRef`, reading at most the harness byte limit plus one |
| `digest` | KHA-119 canonical payload digest |
| `clock`, `newId`, `workerId` | Time, attempt and receipt IDs, and this process's identity |

The test doubles and `createMemoryLedger()`, an in-process reference ledger, live under
`fixtures/`. They are test-only: `index.ts` does not export them, the package export map blocks
`@khala/connector/dispatch/fixtures/*`, and the boundary check refuses production imports of
`fixtures/`. The memory ledger is not durable, so a restart that re-enqueued
from it could submit twice.

## Dispatch order

1. **Precheck**, in one ledger transaction: a queued release that the controls hold now
   (paused, expired, unconfigured, over a limit) records why and waits. It is not verified
   again until the controls change.
2. Verify the release against its approval (`verifyReleasedJob`). Inspect and decode the harness
   capabilities. Read the payload up to the harness byte limit, apply the `DeliveryLimits` and
   compare the digest. Any failure quarantines the release. Nothing is reserved and nothing is
   sent.
3. **Claim**, in one ledger transaction that also reads the clock: recheck revocation, binding
   generation and the binding's own effective policy, check the harness route and the limits,
   reserve one attempt under the causal root and persist the dispatch intent with a stable
   attempt ID.
4. Submit the verified bytes once. Decode the returned receipt, and persist it if it names this
   release and correlates with its binding and generation. A settled submission starts another
   pass.
5. Anything else becomes `outcome_unknown`: a thrown call, a malformed or uncorrelated receipt, a
   receipt whose commit failed, a transport write, or a `failed` caused by `disconnected` or
   `timeout`.

If even the fallback to `outcome_unknown` cannot be committed, the record stays `dispatching`.
Composition must therefore call `reconcile` on startup for every `dispatching` record. That
marks it `outcome_unknown` unless native evidence settles it, and it never resubmits.

## Harness route

A job is claimed only for a route that delivers into the existing session without steering a turn
the human is running (KD1). The decoded `HarnessCapabilities` must report `support` other than
`unsupported`, `existingSession: khala_hosted_resume`, the binding's own `harness`, and `busy` of
`queue` or `reject`. Otherwise the job waits as `harness_unsupported`, even when the ledger shows
the session idle.

## Linearization point and in-flight limit

The claim transaction is the linearization point. For UI copy:

- A pause, revocation or binding change that the connector has applied to the ledger
  **before** the claim blocks the job.
- A control applied **after** the claim does not recall the submission. That job may still
  reach the session. There is no cancellation.
- A pause that the cloud accepted but the connector has not applied is `pending`, not
  effective.

## Records

```
queued → dispatching → accepted → completed
   │          │           └─────→ failed | cancelled
   │          └→ outcome_unknown → accepted | completed | failed | cancelled | abandoned
   └→ quarantined | rejected
```

A record never returns to `queued` after its intent is persisted, so each release is
submitted at most once. Waiting reasons (`paused`, `expired`, `unconfigured`,
`budget_exhausted`, `at_capacity`, `busy`, `harness_unsupported`) leave the record queued for a
later `wake()`.
`stale_binding`, `stale_policy`, `revoked` and `busy` under a `reject` policy reject it.

`reconcile(releaseId)` asks the harness for native evidence about an unfinished intent. With
no evidence, a `dispatching` record becomes `outcome_unknown`: neither a timeout nor an empty
lookup proves the submission did not happen. A claim made by another process is never
resubmitted, because an expired claim does not prove its owner stopped. `abandon` ends an
unknown outcome. It takes an `OwnerAuthority` whose `ownerId` owns the binding, and records its
`authorizationId` on the record. Any other authority is refused. This module does not check that
the authorization is fresh or unused: composition must pass only an `authorizationId` it has just
authenticated for this abandon, and must refuse to reuse one.

Receipts from `submit`, `reconcile` and `observe` are decoded with `decodeDeliveryReceipt` before
they touch a record. Each record keeps at most `MAX_RECEIPTS` receipts. A stored receipt ID that
comes back with other content is refused.

`stop()` stops new claims and waits for the submissions this instance already started. The
dispatcher sets no submission timeout, because a timeout does not show whether the harness
accepted the job.

## Limits

`DispatchPolicy` is candidate configuration, not an approved product default. The ledger holds
one effective policy per binding. A missing policy, or one with an unknown or missing field, a
non-boolean `paused`, an invalid `armedAt`, a limit that is not a positive safe integer, an expiry that is not a strict
UTC timestamp, or an unknown `busy` value, blocks every claim on that binding.

- `maxJobsPerCausalRoot` counts dispatch attempts under the trusted causal root the
  releaser sets. It is a job-count cap, not a spend or token cap. Nothing in this module
  resets or refunds a reservation, including after a definitive rejection, an unknown
  outcome or an abandon. Each approval has at most one release: enqueueing the same release
  ID with another root, or a second release of an approval that already has one, is a
  `conflict`.
- `maxConcurrentJobs` counts `dispatching`, `accepted` and `outcome_unknown` records across all
  bindings, against the claiming binding's limit.
  Accepted work holds its slot until `observe` records `completed`, `failed` or
  `cancelled`. An unknown outcome holds its slot until evidence arrives or it is abandoned.
- `busy` applies when the bound session already has active work: `wait` holds the job,
  `reject` rejects it, `queue` submits it only if the harness route reports `busy: queue`.
  Otherwise it waits.
- `version` is the binding's effective policy version. As in KHA-120's trust transitions, every
  revision bumps it, including a pause or a resume.
- `armedAt` is the version of the newest effective revision that changed the binding's `mode`,
  `peerParticipantId` or generation. A release is current only when
  `armedAt <= policyVersion <= version`. A re-arm of one binding therefore rejects that binding's
  releases queued before it, and leaves other bindings alone. A pause and a resume leave queued
  releases current: released at v3, paused at v4, resumed at v5, the job dispatches once.
  A release from a version the connector has not applied yet is also stale. Composition
  (KHA-135) derives `armedAt` from the KHA-120 revisions the connector has applied. A policy whose
  `armedAt` is not a safe integer between 0 and `version` blocks the binding.

## Open gate

**G-AUTOMATION remains open.** Budget units and limits, reset authority, refund on
definitive rejection, pause scope and busy behavior are not decided. Tests use explicit
fixture values only. Without launch configuration, dispatch stays blocked.
