# `@khala/messaging/browser-device`

Browser encrypted device lifecycle (KHA-111). `createBrowserDeviceService` implements the
`DevicePort` contract from `@khala/contracts/messaging` (KHA-105). It owns at most one live
generation per service: one owner lock, one crypto store and one SDK client for one owner.

Import from `@khala/messaging/browser-device/index`.

## Injected seams

No messaging SDK is imported here. G-SUBSTRATE is open, and Matrix is a candidate, not a
selection. The substrate adapter plugs in through these seams:

| Seam | Supplies | Browser adapter here |
|---|---|---|
| `IdentityPort` | Signed-in principal (KHA-110) | — |
| `CredentialSource` | Substrate device ID, published key fingerprint, opaque credentials | — |
| `CryptoStoreFactory` | Reserved persistent store, never an in-memory fallback | `createIndexedDbStoreFactory` |
| `DeviceEngineFactory` | SDK client over that store; `open` is local-only, `start` goes online | — (substrate adapter) |
| `IdentityMarkerStore` | Enrolled device ID and fingerprint, kept apart from the crypto store | `createIndexedDbMarkerStore` |
| `OwnerLockProvider` | Browser-wide exclusive owner lock | `createWebLockProvider` (Web Locks) |

A Matrix adapter maps onto these the same way KHA-141's `experiments/browser-crypto/src/lifecycle.ts`
does: `initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: store.name })` in `open`,
`getOwnDeviceKeys()` as the fingerprint source, and `startClient()` in `start`.

## Lifecycle

`new → initializing → ready`, with `failed`, `locked`, `lost` and `revoked` as the other
outcomes. `ensureReady` returns:

| Result | When |
|---|---|
| `ok(view)` | Any lifecycle outcome, including `failed`, `locked`, `lost` and `revoked` views |
| `rejected('owner_mismatch')` | The signed-in principal is another owner |
| `rejected('unsupported_environment')` | No exclusive browser lock exists; there is no unsafe fallback |
| `unavailable()` | Identity unavailable, another tab kept the owner lock for the bounded wait (`lockWaitMs`, default 10 s), or a newer request superseded this one |
| `outcome_unknown` | The caller aborted its wait; initialisation carries on |

Rules:

- Same-owner calls coalesce into one generation. `use(ownerId, operation)` queues behind
  that owner's in-flight initialisation and otherwise refuses with `not_ready` or
  `owner_mismatch`. It never opens a client. A result produced after its generation
  ended is discarded as `not_ready`. An operation that throws yields `operation_failed`.
- A generation belongs to the principal (owner and provider account) it was opened for.
  `use()` confirms that principal before and after running the operation. If the identity
  port reports a sign-out, `use()` locks the device; if it reports another principal,
  `use()` retires the generation to `new` and refuses with `owner_mismatch`. An
  `ensureReady` that answers `owner_mismatch` retires whatever belongs to someone other
  than the signed-in principal. A transient `unavailable` identity keeps the generation.
- Identity is read again after the owner lock is granted and before `ready` is
  published, so a sign-out or account switch during the lock wait or during
  initialisation never yields `ready`.
  Every request that changes state carries an epoch. A slower, superseded request
  (a sign-out, an account switch or `acceptLoss`) never publishes over a newer one.
- The engine opens, then its local identity is checked **before** `start`. A marker that
  names this device with another fingerprint is `lost/storage_cleared`. Local keys that
  differ from the server's published keys are `lost/key_material_missing`. The old device
  ID is never reused with a new keyset, so replacement keys never leave the tab.
- `lost` and `revoked` are sticky. Leaving `lost` takes `acceptLoss(ownerId)`, which the
  approved recovery or re-enrolment flow (KHA-129/127) calls. It clears only the marker;
  the next attempt still needs a device whose published keys match, in practice a newly
  enrolled one.
- If the marker cannot be written (for example on quota exhaustion), the result is
  `failed/storage_unavailable`, never `ready`.
- Expired sessions and sign-out go to `locked/signed_out`. Key material and the marker are
  not deleted.
- Ending a generation, whether by account switch, sign-out, expiry, revocation or `stop`,
  first invalidates it. Then it runs `onEnd` projection wipes, then closes the engine, the
  store and the lease in that order. Callbacks wrapped with `context.guard` and engine
  `emit` calls from an ended generation are dropped. Revocation advances `generation`.
- `engine.start()` and `engine.close()` are bounded by `engineTimeoutMs` (default 30 s).
  A start that overruns fails as `failed/initialization_failed`. A close that overruns
  leaves the store and owner lock held, because the engine may still be writing; closing
  the tab frees them.
- Revocation does not delete the revoked device's crypto store; it stays in IndexedDB.
  Erasing it belongs to the open revocation-erasure decision (P07).

A tab that cannot get the lock never reserves the store or opens a client. When the owning
tab closes, the browser hands the lock to a waiting tab, which reopens the same persisted
store. State is never cloned.

**Gap: no follower state channel.** Plan U2 describes a second tab that follows the
owning tab's state. That is not built. A second tab waits up to `lockWaitMs` for the lock
and then reports `unavailable` with a `failed/storage_unavailable` view; it never becomes
a second writer.

## Substrate adapter obligations

The engine seam carries lifecycle only. The substrate adapter must also:

- share room keys only with verified devices (Matrix `OnlyTrustedDevices`);
- classify withheld and missing keys strictly, not as generic decryption failures;
- rotate outbound sessions when room membership or device trust changes.

## Tests

- `pnpm --filter @khala/messaging test`: lifecycle, ownership, identity and transition
  behaviour against injected fakes, and the IndexedDB adapters (`storage.test.ts`) against
  a scripted IndexedDB. These prove module behaviour only. Quota and write-failure
  coverage, including a transaction that aborts at commit, uses these fakes; no test
  exhausts a real browser quota.
- `pnpm --filter @khala/messaging test:browser`: real Chromium with a persistent profile
  across full browser-process restarts (distinct `SingletonLock` PIDs). Web Locks, IndexedDB
  and the service are production code. The engine is a harness stand-in holding
  non-extractable Web Crypto keys in the reserved store. The test covers restart
  decryption, two-tab contention and handover, cleared crypto storage, and whole-profile
  loss against published keys. It does not prove Matrix SDK behaviour; KHA-141 covers that
  (`docs/evidence/browser-crypto.md`).

## Limits

Local browser storage does not resist malicious same-origin JavaScript. Clearing site
data, storage eviction under quota pressure and service-worker updates can lose keys, and
the service reports that as `lost`, never as recovered history. Browsers other than
Chromium are not tested.
