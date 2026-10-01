# Owner browser device pin for the hosted connector

The protected browser must open its Matrix crypto device and publish its Ed25519 key
before registering a pin. For one active agent binding, call:

1. `GET /api/human/owner-device-proof/challenge?room_id=...&device_id=...&binding_id=...&binding_generation=...`
   with the signed-in owner cookie. The response supplies a short-lived nonce.
2. `POST /api/human/owner-device-proof/register` with the same cookie and CSRF
   protection. The exact JSON keys are `v:1`, `roomId`, `bindingId`, `generation`,
   `deviceId`, `fingerprint`, `nonce`, and `matrixAccessToken`. The token is the
   browser's current Matrix device token and must stay transient. Registration
   checks Matrix `/account/whoami` against the signed-in owner's server-minted
   user and exact device, then `/keys/query` against the submitted public key.

The server consumes the nonce once and pins only the public fingerprint under the
owner, room, binding ID, and generation. It rechecks active binding, owner room
membership, and the closure marker. A replacement binding or generation needs a
new browser registration. The connector retrieves only these pins through its
DPoP-bound current binding; lookup also requires the exact key to remain published
by Matrix. A missing or unavailable key fails closed, while a changed fingerprint
is refused. It must never trust an unpinned Matrix device-list key.

To retire a demonstrably missing pin, first revoke its binding through the normal
owner-approved revocation flow. Then the signed-in owner can POST
`/api/human/owner-device-proof/retire` with CSRF protection and the exact JSON
keys `v:1`, `roomId`, `bindingId`, `generation`, `deviceId`, `currentDeviceId`,
`currentFingerprint`, and `matrixAccessToken`. The current device must be a
different owner browser device whose token and published key verify exactly;
the token is never persisted. Matrix must report
the key missing twice, more than 15 seconds apart. The first observation returns
`202`; a later exact match or changed fingerprint blocks retirement. Retirement
records a durable tombstone before removing the index entry, so a partial index
write cannot restore the pin. Reconnection after retirement requires a new
owner-approved binding and browser key registration; an existing connector treats
a disappearing pin as revocation.

The owner browser must verify the connector's attested public device key before
sharing room keys. After that trust transition, use the supported Matrix SDK
`crypto.forceDiscardSession(roomId)` on the sender so messages sent before trust
do not keep using an outbound Megolm session that withheld the connector key.
No old pending plaintext is re-encrypted to a newly admitted browser device:
unavailable history stays unavailable under P14.

This is an authenticated browser-device declaration using the OIDC session,
CSRF boundary, one-use challenge, and current Matrix device token. It does not
claim a private-key signature proof or approval of ordinary message content.
