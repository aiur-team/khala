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
- `persistPending` → `commitCursor` is the ingestion order. An event is durably stored
  before the application cursor may move past it.
- Consumers (KHA-121/130/133/134/135) use `storage.ledger.transaction(tx => …)`. The
  callback is synchronous local SQLite work only: no SDK, network, model or harness
  call. A callback that returns a promise, or a nested transaction, is refused and
  rolled back. Any throw rolls back everything.
- Failures are `StorageError` with a closed `code`. Messages never carry SQLite text,
  paths, payloads or keys.

## Storage engine

Node's built-in `node:sqlite` (SQLite 3.51 on the pinned Node 22.23.2), with STRICT
tables, WAL and `synchronous=FULL`. It adds no package or lockfile dependency. On
Node 22 it prints an `ExperimentalWarning`. The plan leaves the final binding choice to
KHA-101 after KHA-142; swapping it touches only this directory.

## Invariants

| Invariant | Mechanism | Test |
| --- | --- | --- |
| One owner process | `locking_mode=EXCLUSIVE`: an OS lock held for the connection's life, dropped by the kernel on process death (no PID file) | `crash.test.ts`, `open.test.ts` |
| Ownership fencing | Durable open epoch, bumped per open and re-checked at every transaction | `open.test.ts` |
| Owner-only state | Directory 0700, ledger and companion files 0600, no symlinks, no hard links, absolute paths without `..` | `open.test.ts` |
| No silent schema drift | `application_id` + `user_version`; foreign or newer files are refused | `open.test.ts` |
| One review item per event and recipient | Key is room/event/binding/generation; identical text in distinct events stays distinct | `ledger.test.ts` |
| Approved content is never overwritten | A changed digest or attribution is quarantined, and cursors stay blocked until it is resolved | `ledger.test.ts` |
| Content matches its reference | sha256 of the exact `encodeMessageContent` bytes must equal `contentDigest` | `ledger.test.ts` |
| Cursor never advances optimistically | Compare-and-set on a durable revision | `ledger.test.ts`, `crash.test.ts` |
| New generation adopts nothing | Records stay keyed by their generation; releasing them under a new binding is refused and they are reported as stale | `ledger.test.ts` |
| Release is all or nothing | Command outcome, payload and job commit in one transaction, re-checked against binding, pending references, digest and ledger revision | `ledger.test.ts` |
| Unknown outcome stays unknown | Recovery lists releases with no terminal receipt; storage never authorises a resubmit | `crash.test.ts` |

## Crash matrix

| Crash window | Behaviour here |
| --- | --- |
| Ciphertext fetched, nothing stored | Cursor not committed, so the SDK/server replays it |
| SDK crypto advanced, pending write absent | **Not solved here.** Needs the SDK's re-delivery/decryption capability (see blockers) |
| Pending committed, cursor absent | Replay returns `duplicate`; one review item (AE1) |
| Cursor commit outcome unknown | Reopen and `readCursor`; a retried stale compare-and-set reports the durable revision |
| Release exists, harness acceptance unknown | `unresolvedReleases` in the recovery report |

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
