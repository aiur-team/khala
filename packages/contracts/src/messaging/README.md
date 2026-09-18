# `@khala/contracts/messaging`

Identity, room and messaging ports (KHA-105). This domain holds data shapes, strict
decoders and port interfaces. It has no SDK, storage, network or delivery-domain imports,
and it does not claim any runtime E2EE property.

Import from `@khala/contracts/messaging/index`. The package reserves the
`./messaging/*` subpath (KHA-101). Nothing here depends on `@khala/contracts/delivery/*`;
KHA-106 mirrors the scalar shapes below independently.

## Identities stay separate

| Concept | Type | Identity key |
|---|---|---|
| Human owner | `AuthPrincipal` | `providerIssuer` + `providerSubject`. `verifiedEmail` is contact data, and `ownerId` is an opaque key that is never the email |
| Room participant | `ParticipantView` | `participantId`. `kind` (`human`/`agent`) and `ownerId` come from the authenticated mapping, never a label |
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

Display names are nonempty. Display names and room titles reject control characters,
bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) and invisible
U+200B, U+2060 and U+FEFF. ZWNJ and ZWJ stay allowed because Persian and Indic scripts
and emoji sequences need them.

## Immutable content references

`EventRef.contentDigest` is `sha256:` plus 64 lowercase hex characters, taken over
`encodeMessageContent`: the UTF-8 encoding of the compact JSON array
`["khala.message.v1","text",body]`. The body is never Unicode- or newline-normalised.
Adapters hash the bytes that will be released, not rendered HTML or markdown, and not an
encrypted blob. An edit produces a new event with a new reference. `decodeTimelineItem`,
`decodeTimelinePage` and `decodeRoomSnapshot` recompute every digest, so a reference paired
with any other body is rejected. The author device is not checked against the participant's
current devices, because devices rotate. To approve a specific event, compare the whole
reference with `sameEventRef`.

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
closed enum — `missing_keys`, `withheld_unverified` (see the KHA-142 evidence
categories), `decrypt_failed` or `unsupported` — never a free-text SDK error. The
`ref` identity and ordering are unaffected: an unavailable item still carries a full
`EventRef`, and `decodeTimelineItem`/`decodeTimelinePage`/`decodeRoomSnapshot` skip
digest verification for it, because there is no recovered plaintext to hash. UI
rendering of the placeholder is out of scope here (KHA-123).

Widening `TimelineItem.content` to accept `kind: 'unavailable'` needs the same
synchronized-deploy discipline as a `v` bump, even though neither `MessageContent`
nor `TimelineItem` carries a changed version number: a producer that emits an
unavailable item before every consumer has this contract version will fail that
consumer's whole page or snapshot decode (`readItems` decodes eagerly, so one
unrecognized item fails the batch), not just drop the one item.

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
| `RoomPort` | KHA-112 |
| `AdmissionPort` | KHA-113 |
| `RevocationPort` | KHA-128 |
| `RecoveryPort` | KHA-129 |
| `ControlStore` | Specified here, persistence adapter supplied by KHA-131 |

Observers receive full replacement snapshots tagged with the client lifecycle
`generation`. Consumers drop stale generations with `isCurrentGeneration`. `DeviceView.generation` is also the
`expectedGeneration` of a device revocation, and `SessionBinding.generation` is the
`expectedGeneration` of a binding revocation. Recovery
secrets cross only the local `ProvideRecoverySecret` callback, and serialisable
decoders reject unknown fields such as a smuggled `recoveryKey`.

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
`SessionBinding`, `EventRef`, `MessageContent` and `UnavailableContent`) bumps `v` on any change to its shape,
and a bump is a reviewed change on both producer and consumer. `SessionBinding` carries
`v` because the delivery domain mirrors it.

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
exported at runtime: `exact-intro.json`, `invalid.json`, `views.json` and
`control-store.json`. `invalid.json` holds every invalid peer the plan lists: decoder
failures under `cases`, and well-formed values that a comparison or the control store
must refuse under `peers`.
