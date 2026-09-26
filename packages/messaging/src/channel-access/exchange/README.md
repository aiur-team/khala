# `@khala/messaging/channel-access/exchange`

This module is the connector-only exchange behind RD5A, `channel-access-grant-exchange`. A connector holding an
owner-approved channel-access operation presents that operation, its authenticated Ed25519 proof key, the device
it reserved and a separate X25519 recovery key. It receives one versioned sealed envelope in return.
`createGrantExchangeService(deps).forConnector({ sessionFingerprint })` returns an `AdmissionGrantExchangePort`.
`authority.ts` adapts the shared channel-access journal (`../journal/`) to `GrantExchangeAuthorityPort`, and
`grants.ts` is the `ControlStore` grant issuer. Both are shared by the hosted wiring in
`apps/control/src/composition/agent/channel-access-exchange.ts` and the internal wiring in
`apps/internal/src/composition/channel-discovery/`.

## State machine

A `ControlStore` record keyed by (requester, origin, operation) moves through
`bound → admitting → admitted → sealed → acknowledged`. It can also move to `closed`.

1. The first matching exchange persists the device, proof-key thumbprint, session and recovery key, along with a
   stable provider operation, before any effect. A key-index record pins each recovery key to one operation
   (`key_reuse`).
2. Immediately before admission, and again immediately before minting, `GrantExchangeAuthorityPort.authorize`
   rechecks approval. It covers the persisted seven-day deadline (`expired` at or after it), the request revision,
   the current owner, channel visibility and existence, and requester revocation. A failure closes the exchange
   without membership.
3. `admitting` is written before the provider is called. A resumed `admitting` record reconciles first and
   invokes the same provider operation again only on proof of `not_applied`. Unresolved ambiguity stays
   `unavailable`.
4. The service mints a one-time grant that expires after 15 minutes. It seals the canonical `SealedGrantPayload`
   with libsodium `crypto_box_seal`, algorithm `crypto_box_seal_x25519_xsalsa20poly1305` (decision 41), and stores
   the envelope with a seven-day hard recovery expiry.
5. After that, every retry of the same bound tuple returns the byte-identical stored envelope. It makes no
   provider call and does no minting or sealing. A different recovery key is `encryption_key_mismatch` after
   sealing, and supersedes the old key only before sealing.
6. `acknowledge` is the connector's readiness acknowledgement, sent after local activation, for the same
   bound tuple and recovery-key thumbprint. `GrantExchangeAuthorityPort.markConnected` first moves the journal
   to `connected`. The record then becomes `acknowledged`, and its envelope is deleted. A duplicate
   acknowledgement returns the same success. After it, the exchange is `closed`. Nothing except a `sealed`
   record can be acknowledged. The hosted route is `/api/agent/channel-access/ready`.
7. `/api/agent/channel-access/resume` (control's `channel-access/exchange/resume.ts`) finishes an operation whose
   grant was already redeemed, without a grant. It needs the connector's proof for the key the exchange was
   bound to, a `sealed` record inside its seven-day recovery window, a consumed grant (proof of admission),
   and a fresh `GrantExchangeAuthorityPort.authorize`. It returns the binding created at redemption with a
   new adapter capability for that key. It never mints, seals or admits, and it is `closed` on revocation,
   ownership loss, expiry or a revoked binding.

## Guarantees and limits

- The plaintext grant exists only inside the sealed box. The issuer stores only its hash. Status, CLI and MCP
  never see the envelope.
- The exchange never activates the connector and never reports `connected`. The journal stays `connecting` until
  `channel-access-activation` acknowledges readiness. Only then does `acknowledge` mark it `connected` and delete
  the envelope. Otherwise the envelope lives until its seven-day hard expiry.
- Sealed boxes are anonymous: anyone with the public key can seal to it. The connector must therefore open the box
  and run `validateSealedGrantPayload` against its own tuple before activation. The server verifies the grant
  itself at redemption.
- If recovery happens after the grant's 15-minute lifetime, the connector gets the same envelope, but its sealed
  `expiresAt` has passed. Activation treats that as `repair_required`. It is never reminted.
