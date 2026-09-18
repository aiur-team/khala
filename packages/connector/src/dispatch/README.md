# `@khala/connector/dispatch`

Bounded model dispatch (KHA-121). `createDispatcher(deps)` moves released jobs into their
bound session through the KHA-106 `HarnessPort`, within the effective human controls and
finite automation limits. Every effect goes through an injected port, so this module imports
no storage, policy, SDK or harness implementation. KHA-133 binds the durable ledger,
subscription and harness; KHA-135 binds pause and budget status.

| Port | Responsibility |
|---|---|
| `DispatchLedger` | One local transaction at a time: effective policy, binding state, dispatch records and causal counters. Must be serializable across processes. No external effect runs inside it |
| `HarnessPort` (contract) | `inspect`, `submit`, `reconcile` for the bound session |
| `approvals` | The approval a release names, from the owner connector's own ledger |
| `payloads` | Owner-local payload bytes by `payloadRef` |
| `digest` | KHA-119 canonical payload digest |
| `clock`, `newId`, `workerId` | Time, attempt and receipt IDs, and this process's identity |

`createMemoryLedger()` is an in-process reference ledger for tests. It is not durable.

## Dispatch order

1. Read the queued release. Verify it against its approval (`verifyReleasedJob`), read its
   payload, apply the harness `DeliveryLimits` and compare the digest. Any failure
   quarantines the release. Nothing is reserved and nothing is sent.
2. **Claim**, in one ledger transaction: recheck the effective policy, revocation and binding
   generation, check limits, reserve one attempt under the causal root and persist the
   dispatch intent with a stable attempt ID.
3. Submit the verified bytes once. Persist the returned receipt if it names this release and
   correlates with its binding and generation. A settled submission starts another pass.
4. Anything else becomes `outcome_unknown`: a thrown call, an uncorrelated receipt, a
   transport write, or a `failed` caused by `disconnected` or `timeout`.

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
`budget_exhausted`, `at_capacity`, `busy`) leave the record queued for a later `wake()`.
`stale_binding`, `stale_policy`, `revoked` and `busy` under a `reject` policy reject it.

`reconcile(releaseId)` asks the harness for native evidence about an unfinished intent. With
no evidence, a `dispatching` record becomes `outcome_unknown`: neither a timeout nor an empty
lookup proves the submission did not happen. A claim made by another process is never
resubmitted, because an expired claim does not prove its owner stopped. `abandon` ends an
unknown outcome on owner authority. The caller checks that authority.

`stop()` stops new claims and waits for the submissions this instance already started. The
dispatcher sets no submission timeout, because a timeout does not show whether the harness
accepted the job.

## Limits

`DispatchPolicy` is candidate configuration, not an approved product default. A missing
policy, or a limit that is not a positive safe integer, blocks every claim.

- `maxJobsPerCausalRoot` counts dispatch attempts under the trusted causal root the
  releaser sets. It is a job-count cap, not a spend or token cap. Nothing in this module
  resets or refunds a reservation, including after a definitive rejection, an unknown
  outcome or an abandon. Enqueueing the same release ID with another root, or a second
  release of an approval that already has one, is a `conflict`.
- `maxConcurrentJobs` counts `dispatching`, `accepted` and `outcome_unknown` records.
  Accepted work holds its slot until `observe` records `completed`, `failed` or
  `cancelled`. An unknown outcome holds its slot until evidence arrives or it is abandoned.
- `busy` applies when the bound session already has active work: `wait` holds the job,
  `reject` rejects it, `queue` submits it only if the harness route reports `busy: queue`.
  Otherwise it waits.
- `version` must equal the release's `policyVersion`. A version change therefore rejects
  releases queued under the old version. KHA-135 should apply a pause without changing it.

## Open gate

**G-AUTOMATION remains open.** Budget units and limits, reset authority, refund on
definitive rejection, pause scope and busy behavior are not decided. Tests use explicit
fixture values only. Without launch configuration, dispatch stays blocked.
