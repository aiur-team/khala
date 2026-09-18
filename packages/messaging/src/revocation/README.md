# `@khala/messaging/revocation`

Device and agent-binding revocation (KHA-128). `createRevocationService` implements the
KHA-105 `RevocationPort` for one authenticated human (`AuthPrincipal`). Every effect goes
through an injected port, so this module imports no control backend, storage provider or
SDK. Composition roots bind them (KHA-136).

| Port | Responsibility |
|---|---|
| `ControlStore` (contract) | Operation journal. Intent is written before any remote effect |
| `RevocationTargets` | Owner, durable control-plane generation, and messaging device (ID and identity key) of the device or binding |
| `RevocationControlPort` | Khala's disable: refuses new and queued release/dispatch and moves the target to its revoked generation. For a binding, also invalidates every adapter token issued for it |
| `ProtocolRevocationPort` | Selected SDK: removes a device by ID and key, reads its status, and rotates every outbound session shared with the key |
| `AcknowledgmentReceiver` | Endpoint-facing: records only an endpoint's acknowledgment. It grants no revoke or status rights |

## Operation

`revoke` checks ownership and `expectedGeneration`, then records the intent together
with the messaging device it will exclude. Only after that write is confirmed does it call
anything remote. Operation IDs are scoped per owner: the journal key is `revocation/` plus
the SHA-256 of `[ownerId, operationId]`, so the key stays within the identifier limit, and
one owner can neither see nor occupy another's IDs. Resubmitting the same request resumes
the operation. The same operation ID with another target or generation returns
`operation_mismatch`, including when it collides with an earlier request's unresolved
intent write. Each journal write's store operation ID names its position and its boundary
values, so a lost write is never retried with different bytes. `revoke` reports only the
journaled state, so it never reports more progress than `inspect` does.

```
requested → local_disabled → protocol_pending → completed | partial | failed
```

Each boundary is tracked and reported separately by `status`:

- **control**: Khala has disabled the target (`pending`, `disabled`, or `stale` when the
  target moved on before the disable). A `stale` answer after a lost response is checked
  against the target: one already at the revoked generation, or one that no longer
  exists, counts as disabled.
- **capability** (binding only): the agent's adapter tokens for the binding are
  invalidated (`pending`, `revoked`).
- **removal**: the SDK removed the device, or the agent's own device for a binding
  (`pending`, `unknown`, `removed`, `refused`, or `superseded`). A lost response is
  resolved by reading status, never by assuming the removal happened.
- **rotation**: every outbound session shared with the device key has been rotated
  (`pending`, `rotated`). Removal alone does not stop a device from decrypting a session
  it already holds, so the device is excluded from future events only after rotation.
- **endpoint**: the endpoint acknowledged that it stopped. An offline endpoint stays
  `pending`, and the operation stays `partial`, not complete.

Removal and rotation run only after the disable is journaled. Rotation runs only after
removal settles. From the first protocol call for an operation until its rotation
returns `rotated`, the adapter must not send on an outbound session shared with the
device key: a send in an affected room waits for the rotation.

Device identity is its key, not its ID or generation. `RevocationTargets.lookup` must
return the durable control-plane generation, which a disabled target cannot advance, and
removal does not consult it. A revoked device that re-initialises with the same key is
still removed. A different key registered under the same device ID is `superseded`: it is
never removed, the old key's sessions are still rotated, and the operation stays
`partial`.

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
- A binding revocation cuts off the agent's release, dispatch, adapter tokens and its own
  device. It does not revoke the agent's messaging account or remove the agent from its
  rooms, so it never reports `completed`: it stays `partial` with
  `account_and_membership_unchanged`. Removing a participant from a room needs its own
  approved capability.
- A replacement device or binding inherits no trust, approval or queued delivery
  authority. A rebind is a new generation with its own authority.

## Evidence

The tests use injected fakes and a simulated substrate whose senders reuse one outbound
session until it is rotated, as Megolm does. A control case shows that removal without
rotation leaves the device reading new events. The tests prove module behaviour only.
G-SUBSTRATE is open, so no SDK's actual membership, device and key-sharing behaviour is
claimed here. KHA-136 wires the real ports, and KHA-138 repeats the forward-access proof
with isolated accounts on the selected SDK.
