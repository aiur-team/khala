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
DPoP-bound current binding; it must never trust an unpinned Matrix device-list key.

The owner browser must verify the connector's attested public device key before
sharing room keys. After that trust transition, use the supported Matrix SDK
`crypto.forceDiscardSession(roomId)` on the sender so messages sent before trust
do not keep using an outbound Megolm session that withheld the connector key.
No old pending plaintext is re-encrypted to a newly admitted browser device:
unavailable history stays unavailable under P14.

This is an authenticated browser-device declaration using the OIDC session,
CSRF boundary, one-use challenge, and current Matrix device token. It does not
claim a private-key signature proof or approval of ordinary message content.
