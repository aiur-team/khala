# `@khala/messaging/rooms`

The `RoomPort` adapter (KHA-112): room creation, intro batches, sends and the timeline
projection. Import `createRoomService` from `@khala/messaging/rooms/index`. UI callers get
the port and never the SDK client, journal or device lifecycle.

## Inputs

| Input | Meaning |
|---|---|
| `principal` | The authenticated owner (`AuthPrincipal`) |
| `actor` | The signed-in participant: the owner's human participant, or an agent that owner delegated. It must share the principal's `ownerId` |
| `device` | `DevicePort` (KHA-111). Effects run only while it is `ready`; `revoked` or `lost` returns `forbidden`, anything else `unavailable` |
| `substrate` | `RoomSubstrate`, the narrow SDK surface in `substrate.ts`. G-SUBSTRATE is open, so the selected SDK's adapter implements it |
| `journal` | `RoomJournal`, device-local storage. It holds message bodies, so it is never the shared `ControlStore`. Tabs may share it, so every update is a compare-and-set on the record revision. `createMemoryRoomJournal` is not durable and only suits tests |
| `limits` | `ContentLimits` from the substrate capability record |
| `clock` | Trusted epoch milliseconds, used for the create lease and local receipt times. Defaults to `Date.now` |
| `onListenerError` | Receives errors thrown by observers. A throwing observer never stops the others or later updates |

## Outcomes

- **Create.** Only a human actor may create a room; a delegated agent gets `forbidden`. The
  intent is journaled before the SDK call, together with a lease (`CREATE_LEASE_MS`). While
  the lease is live, another call with the same `operationId`, from a second click or another
  tab, returns `outcome_unknown` and touches nothing. A lost response is `outcome_unknown`. A
  retry after the attempt ends, or after its lease expires, looks the room up with
  `findCreatedRoom`. It creates again only on proof (`absent`) that nothing was created, and
  only after winning the compare-and-set on the journal record. The same `operationId` with another owner or title
  is `operation_mismatch`. An empty title is `null`. The title is room metadata, and nothing
  here promises that it is encrypted.
- **Intro batches.** `prepareIntro` freezes the room, author, device, item order, bytes and a
  transaction ID per item. Items go out one at a time, in order, and the batch stops at the
  first item that is not accepted. `resumeIntro`, or preparing the identical selection again,
  sends only unresolved items under their original transactions. A changed, extended or
  reordered selection is `operation_mismatch`. A resume by another author or on another device
  is `forbidden`, because transport dedupe is per device. `accepted` means only that the
  transport accepted the event.
- **Send.** The first use of a `clientTxnId` freezes its bytes. A failed or unknown send is
  retried with the same transaction and content. Other content is `operation_mismatch`.
- **Membership.** `revoked` blocks new sends with `forbidden`, and `left` or `joining` with
  `not_joined`. Accepted history is never rewritten.

## Timeline

Every `EventRef.contentDigest` is computed here over the exact decrypted bytes. Events are
keyed by `eventId`, so duplicate, replayed or reordered sync events and the race between the
remote echo and the send response all produce one item. Updates and send echoes from another
lifecycle generation (`DevicePort.current().generation`) are dropped. A new generation starts
from an empty projection, so it never republishes the previous lifecycle's history. Concurrent
intro runs never overwrite each other's progress: a run whose journal write conflicts stops.

The contract's `TimelinePage` and `RoomSnapshot` carry only decrypted messages. The extra
`observeEntries` view adds explicit `unavailable` placeholders (`missing_key`,
`decryption_failed`, `digest_unavailable`) and `local` entries for own sends the room has not
echoed. A late decryption replaces its placeholder, and a decrypted event is never
downgraded. `timeline` drops placeholders, because the contract page has no shape for them.
KHA-105 owns adding one.

## Substrate obligations

The following obligations cannot be proven by typed fakes. The selected substrate must show
each one live (KHA-102, KHA-132):

- Room creation is tagged with the operation ID, and `findCreatedRoom` answers `absent` only
  on proof.
- `sendEvent` deduplicates a transaction on the same device.
- Adapters return finite results and never raw SDK errors. The service still treats a thrown
  effect as `unknown` and a thrown read as `unavailable`.

History disclosure on a new admission belongs to KHA-113. Room creation here opens no history
to later members.
