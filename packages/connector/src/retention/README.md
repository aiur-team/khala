# `@khala/connector/retention`

Local retention sweep for the owner connector (KHA-130). `sweepRetention(input, ports)`
applies an approved retention policy to the connector ledger and returns a
`RetentionReport`. Every effect goes through an injected port. KHA-133 schedules the
sweep and binds the ports; this module starts no timer or daemon.

| Port | Responsibility |
|---|---|
| `RetentionRecordPort` (KHA-115 ledger) | Ordered record pages, the sweep cursor, and the transactional `apply` |
| `ActiveClaimPort` (KHA-121 dispatch) | Whether a dispatch holds a record: `none`, `active`, `outcome_unknown` or `unavailable` |
| `SupportedCryptoMaintenancePort` | The selected SDK's documented maintenance only; `unsupported` is a valid answer |
| `Clock` | Current UTC time |

## Policy

`RetentionPolicy` is the owner's explicit G-RETENTION decision. This module selects no
horizon. Each cutoff is an approved UTC instant or `null`, and `null` keeps that class:

- `pendingBefore`: pending content received before it may be deleted, and only if
  `allowPendingDeletion` is true.
- `releasedBefore`: released content released before it may be deleted.
- `dedupBefore`: receipt/dedup tombstones created before it may be forgotten. The owner
  sets it within the substrate's replay horizon. With `null`, tombstones are kept, so a
  replayed event is a duplicate rather than new review content.

A missing policy, one that does not decode, or a cutoff after `evaluatedAt` refuses the
sweep. A local clock behind `evaluatedAt` also refuses it.

## Eligibility

`evaluateRecord` is a pure function. References win over age: a record is kept while a
backup depends on it, a dispatch claim is active, the claim store cannot answer, or a
dispatch outcome is unknown. Unknown outcomes keep content and the tombstone, so the
evidence against automatic duplicate dispatch survives. A timestamp later than now is
treated as clock skew and kept. Content is eligible only strictly before a cutoff.

## Deletion

The eligibility decision is advisory. `RetentionRecordPort.apply` must, in one local
transaction, compare the record revision, the policy version and every active reference
(approval in progress, release, dispatch claim), and only then delete. A sweeper lease
alone does not close these races: exactly one of approval and deletion wins.

- If approval or a claim wins, the revision has moved and the sweep keeps the record
  (`revision_conflict` or `referenced`).
- If deletion wins, the bytes are removed, a tombstone with the minimal identity is
  kept, and every pending approval that referenced the bytes is marked content
  unavailable in the same transaction. That approval returns an explicit expired answer
  and cannot authorise replacement bytes. Reading the payload returns the tombstone,
  never an empty message.

Operation IDs are deterministic (`retention/<policy>/<action>/<record>/<revision>`), so
a retry after a lost response is recognised and not repeated.

## Resumption and failure

The cursor is tied to one policy version and advances only past a record whose result
is settled. The first storage failure (unavailable, lost response, a thrown error, a
newer policy in the ledger, or a page that repeats or reorders records) stops the sweep
with `interrupted`. The next call resumes at that record. `maxRecords` bounds each call
and ends it with `budget_exhausted`. SDK maintenance runs only after a `complete` pass.

## Report

Counts and reason codes only. No content, event IDs or approval IDs, and it is never
a model-facing hint. `outcome` is `complete`, `budget_exhausted`, `interrupted` or
`refused`, and a storage failure never reports `complete`. Every report lists
`RETENTION_LIMITS`: local cleanup does not recall released model context, delete other
participants' copies, remote ciphertext or backups, or perform a forensic secure erase,
and it keeps minimal identities so replay is not treated as new.

## Evidence

The tests use a fixed clock and an in-memory ledger fake whose methods are atomic, like
a local transaction. They prove module behaviour against the port contract, including
approval-vs-delete and claim-vs-delete races, resumption after interruption and lost
responses, and tombstone replay suppression. They do not prove the KHA-115 ledger, any
SDK, or secure erasure. Retention periods are a later product setting; this module
selects no concrete horizon.
