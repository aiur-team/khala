# Channel-access activation (RD5B, #211)

- **Contract:** `docs/product/internal-mode/room-discovery.md` § RD5B `channel-access-activation`.
- **Binding decisions:** 24 (Khala never launches or terminates the agent), 36, 41 (libsodium sealed boxes), 44.
- **Consumes (merged on `main`):** RD5A `channel-access-grant-exchange` (#302): the exchange service, route and
  envelope; `channel-discovery-contract` envelope/payload decoders and `validateSealedGrantPayload`;
  `agent-link-bootstrap` device, admission and proof ports.

## Objective

After an agent asks for channel access, the connector journals the operation locally and survives restart. It
polls the requester status with bounded, jittered backoff. On approval it reserves a device and generates a
distinct X25519 recovery keypair, and persists both with the operation/proof/device tuple **before** it calls
the exchange. It opens and validates the sealed result, redeems the grant, activates the device, confirms the
`review`/unpaused trust baseline, and acknowledges readiness. The server then marks the journal `connected`
and deletes the stored envelope. `connected` is never reported without that acknowledgement.

## Units

### U1 — Connector activation state machine (`packages/connector/src/bootstrap/channel-access-activation.ts`)

- Ports: activation journal (CAS record plus an owner-only private key), requester status, exchange, grant
  redemption, `ConnectorDevicePort` (reused), review-trust initializer, readiness acknowledgement, proof signer.
- Phases `pending → keyed → admitted → activated → connected`, plus `repair_required(reason)` and
  `closed(outcome)`. Only `activated → connected` follows a readiness acknowledgement (guarded line).
- A missing key before a sealed result rotates it, and the server supersedes the old one. After consumption,
  `encryption_key_mismatch` or a key that cannot open the envelope is `repair_required: recovery_key_lost`,
  and the connector never exchanges again for a new grant.
- A deterministic local failure is `repair_required`. `repair: true` resumes the same operation and device,
  unless the key is lost or the sealed grant has expired.
- Polling: exponential base 1 s, cap 60 s, full jitter, bounded attempts per call; `resumeAll` lists active
  journal rows after restart.

### U2 — HTTP clients (`packages/connector/src/bootstrap/channel-access-http.ts`)

- Exchange and readiness POSTs to the connector routes, each with a fresh DPoP proof. Bounded JSON reads, no
  redirects. A lost exchange response is `unavailable`, and the retry gets the same stored envelope.

### U3 — Owner-only storage (`packages/connector/src/storage/channel-access.ts`, schema v5)

- `channel_access_activations` row: record JSON plus a `recovery_key` BLOB inside the 0700 state directory.
  The record and the key commit in one transaction.

### U4 — Readiness acknowledgement and envelope cleanup (server)

- `packages/messaging/src/channel-access/exchange`: `acknowledge` moves `sealed → acknowledged`. It first
  marks the journal `connected` through the authority port, then drops the envelope. A duplicate
  acknowledgement is idempotent, and nothing else changes phase.
- `apps/control/src/channel-access/exchange`: `markConnected` authority adapter plus the
  `/api/agent/channel-access/ready` route.

## Wrong-implementation test

An owner-approved request whose readiness acknowledgement never succeeds must never report `connected`,
locally or through the requester status.
