# Channel-access grant exchange (RD5A, #210)

- **Contract:** `docs/product/internal-mode/room-discovery.md` § RD5A `channel-access-grant-exchange`.
- **Binding decisions:** 41 (libsodium `crypto_box_seal`, not HPKE — the ticket title's "RFC 9180 HPKE" wording is superseded), 24, 33, 44.
- **Consumes (merged on `main`):** `channel-discovery-contract` envelope/request types and validators, `channel-access-journal` fulfillment port, `agent-bootstrap` proof conventions.

## Objective

A connector that already holds an owner-approved channel-access operation presents the operation, its
authenticated proof key, its reserved device and a separate X25519 encryption key. The exchange rechecks the
approval, records one stable provider operation, admits the device with `history: none`, mints a short-lived
one-time grant, seals it with libsodium `crypto_box_seal`, stores the envelope, and returns it. Any retry of the
same bound tuple returns the byte-identical stored envelope without calling the provider, sealing or minting
again. The exchange never activates the connector and never reports `connected`.

## Units

### U1 — Transport-neutral exchange (`packages/messaging/src/channel-access/exchange/**`)

- `ports.ts`: `GrantExchangeAuthorityPort` (claim + recheck an approved access authorization, close on loss),
  `ChannelAdmissionProviderPort` (`admit`/`reconcile` by stable provider operation), `GrantIssuerPort`
  (mint a bound one-time grant; plaintext is returned once and never persisted), `GrantExchangeContext`
  (authenticated connector facts).
- `seal.ts`: pinned `libsodium-wrappers` sealing of the canonical `SealedGrantPayload`; envelope is checked with
  `decodeSealedGrantEnvelope` before it is stored.
- `journal.ts`: `ControlStore` CAS record per `(requester, origin, operationId)` digest, plus a key-index record
  that pins each encryption key to one operation. Phases `bound → admitting → admitted → sealed`, or `closed`.
  Record expiry is the seven-day envelope hard expiry.
- `service.ts`: `createGrantExchangeService` implementing `AdmissionGrantExchangePort`:
  1. Load record. A sealed record whose binding matches returns the stored envelope (guarded line), or
     `expired` at/after the hard expiry. Binding drift maps to `wrong_device`, `proof_mismatch`,
     `wrong_generation`, `key_reuse` or `encryption_key_mismatch` (after sealing, a new key never reseals).
  2. Absent record: persist binding + provider operation before any effect; claim the encryption key index.
  3. Before admission and again before mint: authority recheck (deadline, request revision, owner,
     visibility/existence, requester revocation). Failure closes the record; `expired` at/after deadline.
  4. `admitting` is persisted before `admit`; a resumed `admitting` record reconciles first and never admits
     twice after a committed result. Unresolved ambiguity stays `unavailable`.
  5. Mint → seal → persist `sealed` → return envelope.

### U2 — Hosted adapters and route (`apps/control/src/channel-access/exchange/**`)

- `authority.ts`: adapter over the journal `ChannelAccessStore.inspectRequester` + `fulfillment.claimAccess` /
  `updateAccess` using a stable claim operation per exchange. Only `approved`/`connecting` proceed.
- `grants.ts`: `ControlStore` grant issuer. 256-bit grant, stored only as a purpose-separated SHA-256 hash with
  its bound tuple and a 10-minute expiry; `redeem` (for `channel-access-activation`) is single-use by CAS.
- `handler.ts`: `POST /api/agent/channel-access/exchange` (exact-path gateway; the contract's parameterised
  `/api/connector/...` path is not expressible, matching how the journal registered its routes). Composition
  supplies `authenticateConnector`; the body is decoded and matched with `validateGrantExchangeRequest`.
  `no-store`, finite codes, envelope-only success body.
- `composition/agent/handlers.ts`: one `channelAccessExchange` slot with a 503 fallback.

## Tests (contract list → location)

| Contract test | Where |
|---|---|
| Curve25519 KAT + sealed-box open/wrong-key/truncation/tamper on the pinned binding | `seal.test.ts` |
| Envelope version/algorithm/context vectors; ciphertext and sealed-context tamper | `seal.test.ts` |
| Byte-identical retry after response loss; **wrong-implementation**: retry after committed provider result → no second provider call, no fresh sealing | `service.test.ts` |
| Grant theft / cross-session; wrong device/proof/origin/generation; key thumbprint mismatch; replay; cross-operation substitution | `service.test.ts`, `handler.test.ts` |
| Deadline boundary race; owner loss, visibility/deletion, revision, revocation races right before exchange | `service.test.ts`, `authority.test.ts` |
| Crash before provider invocation; crash between invocation and reconciliation; unresolved ambiguity | `service.test.ts` |
| Hard envelope expiry | `service.test.ts` |
| Status/CLI/MCP grant absence; no plaintext grant persisted | `authority.test.ts` (real journal), `service.test.ts` store scan |
| Single-use, bound, short-lived grant | `grants.test.ts` |

## Out of scope

Connector polling/private-key storage/activation/readiness ack (RD5B), provider membership implementation,
human UI, discovery projection.
