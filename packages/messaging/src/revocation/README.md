# `@khala/messaging/revocation`

Device and agent-binding revocation (KHA-128). `createRevocationService` implements the
KHA-105 `RevocationPort` for one authenticated human owner. Every effect goes through an
injected port, so this module imports no control backend, storage provider or SDK.
Composition roots bind them (KHA-136).

| Port | Responsibility |
|---|---|
| `ControlStore` (contract) | Operation journal. Intent is written before any remote effect |
| `RevocationTargets` | Authenticated owner and current generation of the device or binding |
| `RevocationControlPort` | Khala's disable: refuses new and queued release/dispatch, and moves the target to its revoked generation |
| `ProtocolRevocationPort` | Selected SDK: removes a device and reads its status |

## Operation

`revoke` checks ownership and `expectedGeneration`, then records the intent. Only after
that write is confirmed does it call anything remote. Operation IDs are scoped per owner:
the journal key is `revocation/` plus the SHA-256 of `[ownerId, operationId]`, so the key
stays within the identifier limit, and one owner can neither see nor occupy another's
IDs. Resubmitting the same request resumes the operation. The same operation ID with
another target or generation returns `operation_mismatch`. Each journal write's store
operation ID names its position and its boundary values, so a lost write is never
retried with different bytes. `revoke` reports only the journaled state, so it never
reports more progress than `inspect` does.

```
requested → local_disabled → protocol_pending → completed | partial | failed
```

Three boundaries are tracked and reported separately by `status`:

- **control**: Khala has disabled the target (`pending`, `disabled`, or `stale` when the
  target moved on before the disable).
- **protocol**: the SDK removed the device (`not_applicable` for a binding, `pending`,
  `unknown`, `confirmed`, `refused`, or `superseded`). A lost response is resolved by
  reading status, never by assuming the removal happened.
- **endpoint**: the endpoint acknowledged that it stopped. An offline endpoint stays
  `pending`, and the operation stays `partial`, not complete.

The protocol step runs only after the disable is journaled, and only while the device is
still at the generation this operation moved it to. If a replacement registered the
device ID again, the operation becomes `superseded` and never removes the replacement.

Acknowledgments must carry the revoked generation. One that arrives before the disable
is journaled gets `unavailable`, and the endpoint resends it. `ignored` is final: an
earlier generation, a replacement target, or an unknown operation. `retryable` is true
only while resubmitting `revoke` could move a boundary. An operation waiting only on an
endpoint is `partial` but not retryable. A timeout is never reported as success: a lost
write or response stays pending or `outcome_unknown`.

Contract mapping for `inspect`: `requested` → `pending`, `local_disabled` and
`protocol_pending` → `propagating`, `partial` → `partial`, `completed` → `complete`. A
`failed` operation was refused before any effect (`stale_generation`), so `inspect`
returns `not_found` for it and `status` shows `failed`.

## What revocation does not do

Each `status` lists these limitations:

- Content an endpoint already decrypted and keys it retained or exported are not
  recalled. Nothing here promises remote erasure. History access for removed members and
  any deletion promise stay open under G-RETENTION.
- A device revocation affects only that device. The participant's other devices and
  credentials that are still valid keep receiving new events as designed.
- A binding revocation blocks Khala release and dispatch for that binding only. It does
  not revoke the messaging account, the device's keys or room membership. Removing a
  participant from a room needs its own approved capability.
- A replacement device or binding inherits no trust, approval or queued delivery
  authority. A rebind is a new generation with its own authority.

## Evidence

The tests use injected fakes and a simulated substrate whose policy shares each new
event's key with the devices registered at send time. They prove module behaviour only.
G-SUBSTRATE is open, so no SDK's actual membership, device and key-sharing behaviour is
claimed here. KHA-136 wires the real ports, and KHA-138 repeats the forward-access proof
with isolated accounts on the selected SDK.
