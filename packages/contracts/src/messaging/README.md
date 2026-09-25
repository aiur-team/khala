# `@khala/contracts/messaging`

Identity, channel and messaging ports (KHA-105). This domain holds data shapes, strict
decoders and port interfaces. It has no SDK, storage, network or delivery-domain imports,
and it does not claim any runtime E2EE property.

Import from `@khala/contracts/messaging/index`. The package reserves the
`./messaging/*` subpath (KHA-101). Nothing here depends on `@khala/contracts/delivery/*`;
KHA-106 mirrors the scalar shapes below independently.

## Identities stay separate

| Concept | Type | Identity key |
|---|---|---|
| Human owner | `AuthPrincipal` | `providerIssuer` + `providerSubject`. `verifiedEmail` is contact data, and `ownerId` is an opaque key that is never the email |
| Channel participant | `ParticipantView` | `participantId`. `kind` (`human`/`agent`) and `ownerId` come from the authenticated mapping, never a label |
| Device | `DeviceView` | `deviceId`, which belongs to neither a human nor an agent |
| Agent working session | `SessionBinding` | `bindingId` + `generation`. Another session needs another binding |

`sameProviderIdentity`, `sameSessionBinding` and `sameEventRef` compare every field
exactly, and tests refuse a match that differs in any single field. Opaque identifiers
(at most 512 UTF-8 bytes, no control characters) are never trimmed, lowercased or
normalised. An email-shaped `ownerId` is rejected.

`OwnerId`, `ParticipantId`, `DeviceId`, `BindingId`, `RoomId` and `EventId` are branded
strings (`string & { readonly __khala: 'OwnerId' }`), so the compiler refuses a device ID
where an owner ID is expected. Decoders produce the branded values, and `decodeOwnerId`
and its siblings brand a lone identifier. The brand key is a string literal, so the
delivery domain can declare a structurally identical mirror without importing this one.

Display names are nonempty. Display names and channel titles reject control characters,
bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) and invisible
U+200B, U+2060 and U+FEFF. ZWNJ and ZWJ stay allowed because Persian and Indic scripts
and emoji sequences need them.

## Immutable content references

`EventRef.contentDigest` is `sha256:` plus 64 lowercase hex characters, taken over
`encodeMessageContent`: the UTF-8 encoding of the compact JSON array
`["khala.message.v1","text",body]`. The body is never Unicode- or newline-normalised.
Adapters hash the bytes that will be released, not rendered HTML or markdown, and not an
encrypted blob. An edit produces a new event with a new reference. `decodeTimelineItem`,
`decodeTimelinePage` and `decodeChannelSnapshot` recompute every digest, so a reference paired
with any other body is rejected. The author device is not checked against the participant's
current devices, because devices rotate. To approve a specific event, compare the whole
reference with `sameEventRef` — an approval or release API only ever takes an `EventRef`,
so an `UnavailableEventRef` (see below) can never reach one.

The worked fixture `fixtures/messaging/exact-intro.json` pins 71 bytes and
`sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b`, computed
independently with Python. The delivery fixtures in KHA-106 must carry the same literal.

String escaping is exactly ECMAScript `JSON.stringify`. `"` and backslash are
backslash-escaped. U+0008, U+0009, U+000A, U+000C and U+000D use their short forms
(`\b`, `\t`, `\n`, `\f`, `\r`). Every other code point from U+0000 to U+001F becomes a
six-character escape with lowercase hex, so U+0001 becomes `\u0001`.
Everything else is raw UTF-8, including DEL, U+2028, U+2029, `<`, `>`, `&` and all
non-ASCII. NUL and unpaired surrogates are refused. The fixture carries a digest vector
for each of these rules.

`digestMessageContent` never throws. It returns `{ ok: false, reason }` with
`invalid_content`, or with `crypto_unavailable` when Web Crypto is missing or fails (for
example on a non-secure origin). The timeline decoders report that case as
`digest_unavailable` and never as a success.

## Unavailable content

`TimelineItem.content` is `MessageContent` or `UnavailableContent`: `{ v: 1, kind:
'unavailable', reason }` for an event whose plaintext cannot be shown. `reason` is a
closed enum of exactly five values, never a free-text SDK error. It maps from
matrix-js-sdk `DecryptionFailureCode` (see the KHA-142 evidence categories):

| `DecryptionFailureCode` | `reason` |
|---|---|
| `MEGOLM_UNKNOWN_INBOUND_SESSION_ID` | `missing_keys` (no room key reached this device) |
| `MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE` | `withheld_unverified` |
| `MEGOLM_KEY_WITHHELD` | `withheld` |
| any other decryption failure | `decrypt_failed` |
| an unrecognized content kind or version | `unsupported` |

A transport error or timeout is never mapped to one of these reasons: it is a page or
snapshot failure outcome (`OperationResult`), never a withheld placeholder.

`readTimelineContent` dispatches on `content.kind` alone, never on whether a `reason`
field is present, and each reader still enforces its own exact field set: a `text`
content carrying `reason`, or an `unavailable` content carrying `body`, is rejected as
an unknown field.

Unlike a decryptable item, an `unavailable` `TimelineItem.ref` is an
`UnavailableEventRef`, not an `EventRef`: it carries the same `roomId`, `eventId`,
`authorParticipantId` and `authorDeviceId`, but no `contentDigest`, because there is no
recovered plaintext to hash. `decodeTimelineItem`, `decodeTimelinePage` and
`decodeChannelSnapshot` therefore skips digest verification for it, and rejects a
`contentDigest` field on its reference outright. `UnavailableEventRef` is missing a
field `EventRef` requires, so it is not assignable to `EventRef` and cannot reach
`sameEventRef` or any approval or release API — approvals only ever apply to decrypted
items. Ordering, per-page dedup and the snapshot room check are unaffected: they key on
`eventId`, which both reference shapes carry, so a producer may later deliver a
decrypted item with the same `eventId` as an earlier placeholder; a consumer's store
replaces the placeholder with that item. UI rendering of the placeholder is out of
scope here (KHA-123).

Widening `TimelineItem.content` to accept `kind: 'unavailable'` needs the same
synchronized-deploy discipline as a `v` bump, even though neither `MessageContent`
nor `TimelineItem` carries a changed version number: a producer that emits an
unavailable item before every consumer has this contract version will fail that
consumer's whole page or snapshot decode (`readItems` decodes eagerly, so one
unrecognized item fails the batch), not just drop the one item.

## Imported history

`imported-history.ts` defines the archive that carries an internal channel's messages
into an external channel when it is made external. The archive travels inside the
external channel's end-to-end encryption; this contract adds no cryptography of its own.

- **Manifest.** `{ v: 1, archiveId, source: { channelId, revision }, importedBy,
  importedAt, recordCount, chunks }`. Each chunk entry lists its `index`, `recordCount`,
  `firstSequence`, `lastSequence` and `chunkDigest`, in order. `importedBy` is the
  signed-in owner's participant that did the import, and it is the only external author.
- **Record.** `{ v: 1, kind: 'imported', sourceRecordId, sequence, originalAuthor: {
  label, kind }, originalSentAt, body, recordDigest }`. `sequence` is source order and
  strictly increases across the archive. The body is kept exactly as sent, with no
  Unicode or newline normalisation. `originalAuthor` is a display label from the source
  channel: it is provenance, not an external participant.
- **Digests.** `recordDigest` is SHA-256 over the positional JSON array
  `["khala.imported-history.record.v1", channelId, sourceRecordId, sequence, label,
  kind, sentAt, body]`. It binds a body to one source channel, record, position and
  attribution, so a body carried with another record's digest is rejected.
  `chunkDigest` is SHA-256 over `encodeImportedHistoryChunk`, which is also the size
  that `maxChunkBytes` bounds. String escaping follows `encodeMessageContent`.
- **Verification.** `decodeImportedHistoryChunk` recomputes every record digest and the
  chunk digest against the manifest's entry. `openImportedHistory` also requires every
  listed chunk, in manifest order, with no source record repeated. A reordered, dropped,
  extra, altered or foreign chunk fails with a located `mismatch`, and a missing Web
  Crypto fails with `digest_unavailable`.
- **Sealing.** `sealImportedHistory` packs records in order and closes a chunk when the
  next record would exceed `maxRecordsPerChunk` or `maxChunkBytes`. The same input
  always gives the same bytes. `ImportedHistoryLimits` come only from
  `decodeImportedHistoryLimits`, which requires `maxPageBytes >= maxBodyBytes` so that
  one maximum-sized body always fits on one agent page.

An imported record carries none of `EventRef`'s fields, so it is not assignable to
`EventRef`, and every native reference, timeline, selection and approval decoder rejects
it as an unknown field. Imported history never enters approval, release, delivery,
receipt or subscription paths. `@khala/messaging/channels/imported-history` projects a
verified archive as a frozen read-only view for humans (`projectImportedHistory`), plus
bounded context pages that an agent reads on request (`importedContextPage`). Neither
produces a `TimelineItem`.

## Outcomes

`OperationResult` is `ok`, `rejected` (a finite code), `unavailable` (nothing happened, so
retry as-is), or `outcome_unknown` (keep the `operationId`, resolve it, and never retry
with new bytes). When a caller aborts a local wait, the result is `outcome_unknown`, not a
cancellation. `SendState.accepted` means only that the transport accepted the event; it
says nothing about whether a model read it. A send that ends in `outcome_unknown` carries
its `clientTxnId` as the operation ID and is resolved by re-sending that transaction,
which the transport deduplicates.

## Ports

| Port | Producer |
|---|---|
| `IdentityPort` | KHA-110 |
| `DevicePort` | KHA-111 |
| `ChannelPort` | KHA-112 |
| `AdmissionPort` | KHA-113; each `share` call carries its immutable per-link admission policy |
| `RevocationPort` | KHA-128 |
| `RecoveryPort` | KHA-129 |
| `ControlStore` | Specified here, persistence adapter supplied by KHA-131 |
| `ChannelDiscoveryPort` | `channel-discovery-contract`; agent-facing requests only |
| `ChannelAccessResolutionPort` | Discovery adapter; side-effect-free target resolution and revalidation only |
| `ChannelAccessRequestJournalPort` | Control service; durable request journal and requester-safe status |
| `ChannelAccessDecisionPort` | Human-cookie composition; owner-authenticated CAS decisions and mutes |
| `ChannelAccessNotificationPort` | Notification outbox; minimal revisioned owner and requester projections |
| `ChannelAccessFulfillmentPort` | Trusted fulfillment worker; separately typed access and creation claims |
| `ChannelCreateAdapterPort` | Human-authorized provider composition only |
| `ChannelPrivateEligibilityPort` | Owner-only private allowlist administration |
| `AdmissionGrantExchangePort` | Connector-only sealed grant recovery |

Observers receive full replacement snapshots tagged with the client lifecycle
`generation`. Consumers drop stale generations with `isCurrentGeneration`. `DeviceView.generation` is also the
`expectedGeneration` of a device revocation, and `SessionBinding.generation` is the
`expectedGeneration` of a binding revocation. Recovery
secrets cross only the local `ProvideRecoverySecret` callback, and serialisable
decoders reject unknown fields such as a smuggled `recoveryKey`.

## Channel discovery is request-only

`ChannelListing` is a strict pre-join projection: version, opaque listing reference,
bounded untrusted title, `public` / `private` / `secret`, service kind and finite request
state. It cannot carry a Matrix room ID, roster, participant count, activity, content,
owner identity or grant. `secret` is representable for storage and owner tooling, but
`ChannelDiscoveryPort.list` never promises to enumerate it. Pages contain at most 25
items, expose no total count and continue only through an opaque cursor.

Titles are capped at 256 UTF-8 bytes. Terminal controls, bidi overrides and unsafe
invisible characters are replaced with U+FFFD so a title stays data in JSON and MCP
output rather than becoming terminal control or instruction text. ZWNJ and ZWJ remain
valid for scripts and emoji that require them.

The agent-facing `ChannelDiscoveryPort` can list, journal an access request, journal a
create intent and inspect finite status. It deliberately has no `create` or `admit`
member. Canonical channel URLs are exact-origin locators: unlike listing references,
they may privately locate a private or secret target for an otherwise unknown agent,
but the only successful pre-join result is `pending_owner`. Invalid, stale and
ineligible targets collapse to `unavailable`. Status is always grant-free.

`ChannelCreateAdapterPort` is separate and requires both a
`HumanAuthorizedWorkflowContext` and an idempotency key for create or reconciliation.
Private eligibility is owner-only, keyed by `StableAgentPrincipal` rather than any
display/device/session label, and carries the session generation that consumers must
revalidate on use.

Discovery credentials bind the exact service origin, stable requester, current session
generation, Ed25519 proof key, expiry and exactly three scopes: `list_channels`,
`request_channel_access` and `request_channel_create`. Grant exchange separately binds
an X25519 encryption key to the proof-key thumbprint plus operation, device, requester,
origin and generation; reusing that encryption key for another tuple is `key_reuse`.
`validateDiscoveryCredential` compares the authenticated proof thumbprint as well as the
requester tuple, after deriving the credential key's RFC 7638 SHA-256 OKP thumbprint.
`validateGrantExchangeRequest` is the only route from decoded caller assertions to
`ValidatedGrantExchangeRequest`: it derives both key thumbprints and compares the
authenticated proof thumbprint plus the operation, device, origin, requester, generation
and expiry. `AdmissionGrantExchangePort` accepts only that validated type.

Channel-access requests bind a stable requester, current session fingerprint and
generation, canonical origin, operation kind and hidden target or proposal. Owner-facing
projections expose only bounded display text and operation-specific detail; they never
carry credentials, grants or provider identifiers. Decisions require an `AuthPrincipal`
and expected revision, while mutes are operation-specific. Approval only records an
approved journal state; it does not itself create a channel, issue a grant or admit a
device.

Fulfillment consumes distinct branded `ChannelAccessAuthorization` and
`ChannelCreateAuthorization` values through separate claim methods. Neither authority
has a decoder from untrusted input, and the fulfillment port has no provider, grant or
admission method. Notifications are also strict, minimal and revisioned so redelivery
does not widen the owner or requester projection.

Grant recovery uses pinned `libsodium-wrappers` and `crypto_box_seal` (X25519 plus
XSalsa20-Poly1305), never HPKE or local cryptographic primitives. The v1 envelope names
`crypto_box_seal_x25519_xsalsa20poly1305`, the recipient-key thumbprint and unpadded
base64url ciphertext; the sealed box embeds its ephemeral public key. The encrypted
plaintext owns the operation/requester/origin/generation/device/thumbprint/expiry
binding because sealed boxes have no separate associated-data input. The strict
`SealedGrantPayload` decoder and validator enforce those fields again after open before
local activation. Tests pin
libsodium's published deterministic Curve25519 key vector and prove valid open,
wrong-key rejection, truncation rejection and ciphertext-tamper rejection.

## Control store

Atomicity is per key. `compareAndSet` with `expectedRevision: null` creates only if the
key is absent. An operation ID names exactly one write: reusing it with other bytes or
another key returns `operation_mismatch`. Expired records read as `absent` against
injected trusted time. A store outage returns `unavailable`, never `absent`.
`fixtures/messaging/control-store.json` holds the conformance scenarios that the selected
persistence adapter must pass live, together with the `controlStore` peers in
`invalid.json`. A provider with per-key atomicity cannot see a write under another key,
so its adapter must first claim the operation ID in a record of its own (key, value and
expiry) to detect `operation_mismatch`. Record values are JSON nested at most
`MAX_JSON_DEPTH` (64) deep, and deeper or cyclic input fails with `too_deep`.

## Decoding and versioning

Decoders are total over parsed JSON and plain objects, including deep or cyclic values:
they return `{ ok: false, error: { path, code } }` instead of throwing. (A Proxy or getter
that throws is outside this guarantee.) Content limits come only from
`decodeContentLimits`, which requires positive safe integers. `ContentLimits` is
branded, and a decoder handed forged limits
fails with `invalid_limits` rather than allowing unbounded input.

Decoders reject unknown fields. The browser and the connector therefore deploy in
lockstep for a given contract version. Every envelope with a `v` field (`AuthPrincipal`,
`SessionBinding`, `EventRef`, `UnavailableEventRef`, `MessageContent`,
`UnavailableContent` and `AdmissionPolicy`) bumps `v` on any change to its shape,
and a bump is a reviewed change on both producer and consumer. `SessionBinding` carries `v` because the delivery
domain mirrors it. `UnavailableEventRef` is a new type, not a change to `EventRef`'s
shape, so `EventRef` keeps `v: 1`.

## Open product gates

G-SUBSTRATE, G-ADMISSION and G-RETENTION are still open. The contracts leave them as
capability inputs and do not choose defaults:

- Content, display-name and title limits come from `ContentLimits`, which the substrate
  capability record supplies.
- Recovery modes are opaque capability identifiers, and no recovery promise is implied.
- The admission result carries no history; disclosure is gated. `Admission` carries
  only the joined room, and a `history` field is rejected. Resolving G-ADMISSION may add
  `Admission.outcome` variants, so consumers handle `outcome` exhaustively.

## Fixtures

The files in `packages/contracts/fixtures/messaging/` are for tests only and are never
exported at runtime: `exact-intro.json`, `invalid.json`, `views.json`,
`control-store.json` and `imported-history.json` (pinned record and chunk digests).
`invalid.json` holds every invalid peer the plan lists: decoder
failures under `cases`, and well-formed values that a comparison or the control store
must refuse under `peers`.
