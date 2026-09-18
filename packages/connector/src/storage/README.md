# Connector storage (KHA-115)

The owner connector's durable **application ledger**: pending review items, replay
cursors, recipient bindings, the approval command journal, releases and delivery
receipts. The messaging SDK keeps its own crypto store. This module never opens, wraps
or migrates it, and **no operation here is atomic with an SDK write**.

```ts
import { openConnectorStorage } from '@khala/connector/storage/open';
import { recoverConnectorStorage } from '@khala/connector/storage/recovery';

const storage = await openConnectorStorage({ directory, mode: 'existing', limits });
const report = await recoverConnectorStorage(storage);
```

- `mode: 'create'` is for first bootstrap only. Every later start uses `'existing'`,
  so lost state is `missing_state` and never silently becomes a fresh identity.
  `bindDeviceIdentity` then refuses a different SDK device or key fingerprint.
- `persistPending` / `persistUnavailable` → `commitCursor` is the ingestion order. An
  event is durably stored, as content or as an unavailable placeholder, before the
  application cursor may move past it. Both take the `streamId` that observed the event.
- Answers the ingestion adapter maps (KHA-116 `EventIngestionPort`):
  - `inserted`, `replaced` and `duplicate` are stored.
  - `conflict_resolved` is handled: the owner resolved it, nothing is adopted and the
    cursor may pass.
  - `conflict` holds the stream until the owner resolves it.
  - `blocked` (`binding_unknown`, `stale_generation`, `revoked`) stores nothing.
- Events are recorded only for a known binding at its current, unrevoked generation.
- Consumers (KHA-121/130/133/134/135) use `storage.ledger.transaction(tx => …)`. The
  callback is synchronous local SQLite work only: no SDK, network, model or harness
  call. A callback that returns a promise, or a nested transaction, is refused and
  rolled back. Any throw rolls back everything. After any `tx` method throws, the
  transaction cannot commit, even if the callback catches the error.
- Caller strings are bounded before they reach SQLite:
  - IDs, stream IDs and fingerprints are at most 512 bytes.
  - Cursors are at most 8 KiB.
  - Timestamps must be real UTC instants.
  - `maxBytes` must be at least 256 KiB.
  - `readQuarantine` returns pages of at most 100 entries.
- Failures are `StorageError` with a closed `code`. Messages never carry SQLite text,
  paths, payloads or keys.
- After `bindDeviceIdentity` reports a conflict, the handle is blocked: every later
  call fails with `identity_mismatch`. In `existing` mode, a first bind on a ledger
  that already holds state is refused (`identity_unbound`).
- Test doubles live in `fixtures/`. The package does not export that directory, and
  `check:boundaries` refuses production imports of it.

## Storage engine

Node's built-in `node:sqlite` (SQLite 3.51 on the pinned Node 22.23.2), with STRICT
tables, WAL and `synchronous=FULL`. It adds no package or lockfile dependency. On
Node 22 it prints an `ExperimentalWarning`. The plan leaves the final binding choice to
KHA-101 after KHA-142; swapping it touches only this directory.

## Invariants

| Invariant | Mechanism | Test |
| --- | --- | --- |
| One owner process | `locking_mode=EXCLUSIVE`: an OS lock held for the connection's life, dropped by the kernel on process death (no PID file) | `crash.test.ts`, `open.test.ts` |
| Ownership fencing | Durable open epoch, bumped per open and re-checked at the start of every transaction | `open.test.ts` (epoch moved under a live handle) |
| Owner-only state | Directory 0700, ledger and companion files 0600, set explicitly regardless of umask. No symlinks, no hard links, and absolute paths without `..`. Every ancestor is a real directory owned by the user or root, and others may write to it only with the sticky bit | `open.test.ts` |
| The opened file is the validated file | The ledger is pinned through an `O_NOFOLLOW` descriptor. After open, every descriptor this process holds for the ledger path (`/proc/self/fd`) must be that inode. Without `/proc` this falls back to re-checking the path | `open.test.ts` |
| No silent schema drift | `application_id` + `user_version`; foreign, newer, versionless or empty files are refused | `open.test.ts` |
| One review item per event and recipient | Key is room/event/binding/generation; identical text in distinct events stays distinct | `ledger.test.ts` |
| Approved content is never overwritten | A changed digest or attribution is quarantined, and that stream's cursor stays blocked until it is resolved. A replay after resolution is `conflict_resolved` | `ledger.test.ts` |
| No event is lost behind the cursor | An undecryptable or unauthenticated event is stored as a placeholder. Only the same key with the same attribution and a verified digest replaces it | `ledger.test.ts` |
| Revocation is durable | A binding revoked at generation G (and earlier), or its device, blocks pending writes, snapshots and releases. Recovery reports it | `ledger.test.ts` |
| Content matches its reference | sha256 of the exact `encodeMessageContent` bytes must equal `contentDigest`; stored bytes are re-verified on every read | `ledger.test.ts` |
| Cursor never advances optimistically | Compare-and-set on a durable revision | `ledger.test.ts`, `crash.test.ts` |
| New generation adopts nothing | Records stay keyed by their generation; releasing them under a new binding is refused and they are reported as stale | `ledger.test.ts` |
| Release is all or nothing | Command outcome, payload and job commit in one transaction, re-checked against revocation, binding, pending references, digest and ledger revision | `ledger.test.ts`, `crash.test.ts` (kill inside the transaction) |
| Unknown outcome stays unknown | Recovery lists a release with any dispatch evidence as `outcomeUnknownReleases` (never resubmit), apart from `undispatchedReleases` | `crash.test.ts`, `ledger.test.ts` |

`busy_timeout=0` and `synchronous=FULL` are set explicitly and asserted in `open.test.ts`.
Both equal the Node 22 / SQLite defaults, so that test pins the effective values rather
than proving the statements are needed.

## Crash matrix

| Crash window | Behaviour here |
| --- | --- |
| Ciphertext fetched, nothing stored | Cursor not committed, so the SDK/server replays it |
| SDK crypto advanced, pending write absent | **Not solved here.** Needs the SDK's re-delivery/decryption capability (see blockers) |
| Pending committed, cursor absent | Replay returns `duplicate`; one review item (AE1) |
| Cursor commit outcome unknown | Reopen and `readCursor`; a retried stale compare-and-set reports the durable revision |
| Release exists, harness acceptance unknown | `outcomeUnknownReleases` in the recovery report; never resubmitted by storage |
| Owner killed inside an open transaction | Nothing from that transaction is visible after reopen |

`crash.test.ts` kills a real child process with SIGKILL. One window is inside an open
transaction; the others are after commit.

## Threat limits

File modes protect against other local users only. A tool running unrestricted as the
same OS user can read the ledger, including pending plaintext. Prefer a separate
privilege boundary where the runtime has one. Plaintext is not encrypted at rest
inside the ledger, and removing rows or files is not secure erasure.

## Not done here

- **SDK/app crash proof (plan U3)** is blocked on G-SUBSTRATE. KHA-142 found durable
  native identity and replay with the bot-sdk wrapper, but rejected it for verified-only
  sharing. The headless-Chromium alternative keeps its crypto store in IndexedDB. No
  substrate is selected, so the SDK-advanced-before-pending window has no proven
  recovery primitive. KHA-116/133 must not assume one.
- `claimDispatch`, `readEffectivePolicy` and `deletePayloadIfUnreferenced` wait for
  the `EffectivePolicy`/`BudgetReservation` records and error unions from KHA-120/121
  and retention policy from KHA-130. `readPayloadReferences` already exposes the
  reference counts KHA-130 needs.
- `putRelease` does not yet re-check the effective policy version. The ledger-revision
  compare-and-set covers any ledger change since the snapshot, and the policy check is
  added once the policy record lives in this ledger.
