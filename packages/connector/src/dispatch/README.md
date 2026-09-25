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
| `DeliveryBoundary` | The route's harness-neutral proved-boundary callback: resolves with the session and current capabilities when a claimed attempt may be delivered, or null. It delivers nothing itself and takes the dispatcher's `AbortSignal` |
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

1. **Precheck**, in one ledger transaction and before any harness call: a queued release that
   the controls hold now (paused, `async` or no usable listening mode, expired, unconfigured,
   over a limit) records why and waits. It is not verified again until the controls change.
2. Verify the release against its approval (`verifyReleasedJob`). Inspect and decode the harness
   capabilities. Read the payload up to the harness byte limit, apply the `DeliveryLimits` and
   compare the digest. Any failure quarantines the release. Nothing is reserved and nothing is
   sent.
3. **Scheduler claim**, in one ledger transaction that also reads the clock: recheck revocation,
   binding generation, the binding's own effective policy and listening mode, check the harness
   route and the limits, reserve the release's one attempt under its causal root, and persist a
   `claimed` record with a stable attempt ID and the route snapshot (below).
4. **Proved boundary**: await `DeliveryBoundary`. If it returns null, throws, or the dispatcher
   stops, the claim returns to `queued` as `boundary_unavailable`, keeping its reservation.
5. **Promotion**, in one ledger transaction: revalidate the snapshot and the release's size
   against the boundary's report, then persist the no-return `dispatching` intent.
6. Submit the verified bytes once. Decode the returned receipt, and persist it if it names this
   release and correlates with its binding and generation. A settled submission starts another
   pass.
7. Anything else becomes `outcome_unknown`: a thrown call, a malformed or uncorrelated receipt, a
   receipt whose commit failed, a transport write, or a `failed` caused by `disconnected` or
   `timeout`.

If even the fallback to `outcome_unknown` cannot be committed, the record stays `dispatching`.
Composition must therefore call `reconcile` on startup for every record that
`reconciliationReleaseIds` lists. A `claimed` record had no effect, so it returns to `queued`
with its reservation. A `dispatching` record becomes `outcome_unknown` unless native evidence
settles it, and it is never resubmitted.

## Listening modes

The applied `DispatchPolicy.listening` projection carries the binding's requested and effective
mode, its own `version`, and the capability `evidenceRevision` the effective mode was derived
from. The listening-mode store derives `effective`; dispatch only reads it.

- Only an effective `steer` or `sync` equal to the requested mode may claim. Effective `async`
  holds as `mode_async`; the agent pulls those releases through `khala_read`. No effective mode,
  or an effective mode that differs from the requested one, holds as `mode_unavailable`. Pause
  is checked first and wins over every mode.
- An arrival wakes the dispatcher only when its binding has a usable, unpaused policy in `steer`
  or `sync`. An `async` or paused arrival only persists: it makes no harness, boundary or
  notification call. Resume is a later policy with `paused: false` followed by one `wake()`;
  wakes coalesce, and none resets or refunds a causal count.
- The claim snapshots `modeAtClaim`, the binding generation and session, the harness, harness
  version, adapter version, route and evidence revision. The capabilities must report `proven`
  or `experimental` support for that mode on the bound harness, at the tested version, under the
  projection's evidence revision. Otherwise the job waits as `harness_unsupported`.
- Promotion requires the durable binding, and the session the boundary reports, to be exactly the
  claimed binding, and every snapshot field to match the boundary's capabilities. Any drift
  returns the release to `queued` as `route_drift`, with no receipt, acknowledgement or refund. A
  release over the boundary's `maxSelectionEvents` or `maxPayloadBytes` returns as
  `boundary_limit`. A revocation found at promotion rejects the release as `revoked`. A pause or
  mode change after the claim is not rechecked: the attempt finishes under `modeAtClaim`.
- A claim waiting at its boundary, or an earlier release on the same binding that went back to
  pending with its reservation, holds that binding's later releases as `busy`, whatever the busy
  policy. An exhausted causal root holds only itself.

## Harness route

A job is claimed only for a route that delivers into the existing session without steering a turn
the human is running (KD1). The decoded `HarnessCapabilities` must report `support` other than
`unsupported`, `existingSession: khala_hosted_resume`, the binding's own `harness`, and `busy` of
`queue` or `reject`. Otherwise the job waits as `harness_unsupported`, even when the ledger shows
the session idle.

## Linearization point and in-flight limit

The scheduler claim is the linearization point for controls. For UI copy:

- A pause, mode change, revocation or binding change that the connector has applied to the ledger
  **before** the claim blocks the job.
- A pause or mode change applied **after** the claim does not recall the attempt. That job may
  still reach the session. There is no cancellation, and pause never implies a hard cancel.
- A revocation, binding replacement or route drift found at promotion keeps the job from the
  session. After promotion nothing recalls the submission.
- A pause that the cloud accepted but the connector has not applied is `pending`, not
  effective.

## Records

```
queued ⇄ claimed → dispatching → accepted → completed
   │        │            │           └─────→ failed | cancelled
   │        └→ rejected  └→ outcome_unknown → accepted | completed | failed | cancelled | abandoned
   └→ quarantined | rejected
```

A `claimed` record returns to `queued` only before promotion, when no effect can have happened.
It keeps `reserved: true`, so a later claim does not reserve again. A record never returns to
`queued` after its `dispatching` intent is persisted, so each release is submitted at most once.
Waiting reasons (`paused`, `mode_async`, `mode_unavailable`, `expired`, `unconfigured`,
`budget_exhausted`, `at_capacity`, `busy`, `harness_unsupported`, `route_drift`,
`boundary_unavailable`, `boundary_limit`) leave the record queued for a later `wake()`. A release
returned from its boundary waits for the next wake rather than retrying at once.
`stale_binding`, `stale_policy`, `revoked` and `busy` under a `reject` policy reject it.

Records written before listening modes decode without a snapshot. A queued one claims normally. A
claimed or in-flight one is never delivered again and advances only through receipts and
reconciliation; current capabilities are never written into its history.

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

Only retained, correlated `DeliveryReceipt` kinds move a record, and only after its intent: a
`claimed` record accepts no receipt. `harness_queued` or a stronger proved observation advances
it, a `failed` refusal fails it, and `outcome_unknown` or a connection-loss failure waits for
reconciliation. There is no generic `delivered` fact, and a process write proves nothing.

`stop()` stops new claims, aborts boundary waits (returning those claims to pending) and waits for
the submissions this instance already started. The dispatcher sets no submission timeout, because
a timeout does not show whether the harness accepted the job.

## Limits

`DispatchPolicy` is candidate configuration, not an approved product default. Local composition
fills its limits from the approved local automation profile, and dispatch consumes only
`maxJobsPerCausalRoot`, `maxConcurrentJobs` and `busy` from it. Automatic release is the sole
enforcer of `maxCausalDepth`: dispatch neither requires nor derives it, and a policy carrying it
is unusable. The ledger holds one effective policy per binding. A missing policy, or one with an
unknown or missing field, a non-boolean `paused`, an invalid `armedAt`, a limit that is not a
positive safe integer, an expiry that is not a strict UTC timestamp, an unknown `busy` value or a
malformed `listening` projection, blocks every claim on that binding.

The SQLite adapter's `applyEffectivePolicy` compares the policy `version` and the
`listening.version` independently. A write may advance either one, but a write that moves either
back is `stale_version`, and one that changes content under an unchanged version is
`version_conflict`. A replacement generation starts a fresh listening version. A policy stored
before listening modes blocks dispatch until a policy with a projection is applied.

- `maxJobsPerCausalRoot` counts dispatch attempts under the trusted causal root the
  releaser sets. It is a job-count cap, not a spend or token cap. Nothing in this module
  resets or refunds a reservation, including after a definitive rejection, an unknown
  outcome, an abandon, route drift or a resume. Budget exhaustion holds that root's remaining
  work; a human-authored message starts a new, independently eligible root, and a re-arm reaches
  dispatch the same way, as a new trusted root from the releaser. Each approval has at most one
  release: enqueueing the same release ID with another root, or a second release of an approval
  that already has one, is a `conflict`.
- `maxConcurrentJobs` counts `claimed`, `dispatching`, `accepted` and `outcome_unknown` records
  across all bindings, against the claiming binding's limit.
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
