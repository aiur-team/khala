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

`sameProviderIdentity` and `sameSessionBinding` compare these fields exactly. Opaque
identifiers (at most 512 UTF-8 bytes, no control characters) are never trimmed,
lowercased or normalised.

## Immutable content references

`EventRef.contentDigest` is `sha256:` plus 64 lowercase hex characters, taken over
`encodeMessageContent`: the UTF-8 encoding of the compact JSON array
`["khala.message.v1","text",body]`. The body is never Unicode- or newline-normalised.
Adapters hash the bytes that will be released, not rendered HTML or markdown, and not an
encrypted blob. An edit produces a new event with a new reference. `decodeTimelineItem`
recomputes the digest, so a reference paired with any other body is rejected.

The worked fixture `fixtures/messaging/exact-intro.json` pins 71 bytes and
`sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b`, computed
independently with Python. The delivery fixtures in KHA-106 must carry the same literal.

## Outcomes

`OperationResult` is `ok`, `rejected` (a finite code), `unavailable` (nothing happened, so
retry as-is), or `outcome_unknown` (keep the `operationId`, resolve it, and never retry
with new bytes). When a caller aborts a local wait, the result is `outcome_unknown`, not a
cancellation. `SendState.accepted` means only that the transport accepted the event; it
says nothing about whether a model read it.

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
`generation`. Consumers drop stale generations with `isCurrentGeneration`. Recovery
secrets cross only the local `ProvideRecoverySecret` callback, and serialisable
decoders reject unknown fields such as a smuggled `recoveryKey`.

## Control store

Atomicity is per key. `compareAndSet` with `expectedRevision: null` creates only if the
key is absent. An operation ID names exactly one write: reusing it with other bytes or
another key returns `operation_mismatch`. Expired records read as `absent` against
injected trusted time. A store outage returns `unavailable`, never `absent`.
`fixtures/messaging/control-store.json` holds the conformance scenarios that the selected
persistence adapter must pass live.

## Open product gates

G-SUBSTRATE, G-ADMISSION and G-RETENTION are still open. The contracts leave them as
capability inputs and do not choose defaults:

- Content, display-name and title limits come from `ContentLimits`, which the substrate
  capability record supplies.
- Recovery modes are opaque capability identifiers, and no recovery promise is implied.
- Admission discloses no history. `Admission` carries only the joined room, and a
  `history` field is rejected.

## Fixtures

The files in `packages/contracts/fixtures/messaging/` are for tests only and are never
exported at runtime: `exact-intro.json`, `invalid.json`, `views.json` and
`control-store.json`.
