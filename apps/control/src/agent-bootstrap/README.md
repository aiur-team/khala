# `@khala/control/agent-bootstrap`

Hosted side of agent-operated link bootstrap (KHA-114), following the trust path
KHA-144 proved. Import `createAgentBootstrapHandlers` from `@khala/control/agent-bootstrap/handler`.
It returns route registrations for both domains, plus the adapter capability checks. KHA-132
composes `human`, KHA-133 composes `agent` and the adapter routes, and KHA-136 passes
`capabilities.lookupBinding`, `capabilities.disableBinding` and `capabilities.revokeAdapterCapability` to
the revocation service.

| Route | Caller | Authority |
|---|---|---|
| `GET /api/agent/bootstrap/descriptor?link=` | Connector | None. It returns the invite, `loopback-browser-v1` and the fixed endpoints. It does not reveal whether the invite exists |
| `GET /api/human/agent-bootstrap/authorize` | Owner's browser | The owner's Khala session cookie. It renders a consent page and issues nothing. Signed-out browsers go to sign-in and back |
| `POST /api/human/agent-bootstrap/authorize` | Owner's browser (the consent form) | Exact `Origin`, same-origin fetch metadata, the session cookie and the session's CSRF token (form field `csrf`) → one-time code at the loopback redirect |
| `POST /api/agent/bootstrap/token` | Connector | One-time code (60 s) + PKCE S256 + the same `redirect_uri` + key proof → 60 s grant |
| `POST /api/agent/bootstrap/redeem` | Connector | `Authorization: DPoP <grant>` + key proof with `ath` → `SessionBinding` + adapter capability |

The redeem response is `{ binding, adapter_capability: { token, token_type: 'DPoP', scope, binding_id, generation, expires_at } }`.

## Guarantees

- **Owner.** The owner comes only from `authenticate(request)`. Link possession, email, display
  names and agent claims carry no authority. A forwarded link opened by someone else binds
  *their* agent under *their* owner ID, never the creator's.
- **Consent.** The GET is read-only. Only the POST issues a code, and it uses the same checks as
  every other human mutation (#68): `Origin` must equal the app origin, `Sec-Fetch-Site`, when
  sent, must be `same-origin`, and the CSRF token must match the session. A cross-site page
  therefore cannot obtain a code for the owner. The page escapes every value, loads nothing and
  cannot be framed.
- **Redirect.** Only an RFC 8252 loopback redirect is accepted: `http`, `127.0.0.1` or `[::1]`, an explicit port, and
  no userinfo, query or fragment. `localhost` is refused. A bad redirect gets a 400, never a redirect.
  Every parameter must appear exactly once. The token exchange must repeat the redirect URI (RFC 6749 §4.1.3).
- **Codes and grants.** Each is a 256-bit random value, stored only under a purpose-separated hash with a
  60 s expiry. A code is consumed by compare-and-set before its verifier, session, device and key are
  checked, so a wrong attempt burns it, and only one of two racing exchanges succeeds.
- **Redeem is single-use.** The first `operation_id` claims the grant by compare-and-set. A retry of that
  operation resumes after a failure, and the recorded admission means it never admits again. The
  grant is marked spent before a capability is minted, so it yields at most one capability. After
  that, presenting it again is `grant_replayed`, even for the same operation. A connector whose
  response was lost runs the ownership step again.
- **Proofs.** Compact EdDSA JWS (`typ: dpop+jwt`) with the embedded Ed25519 public key (a `d` member is
  refused). Its RFC 7638 thumbprint must equal the bound `jkt`. It is checked with `node:crypto` for
  signature, exact `htm`/`htu`, `iat` within 60 s (5 s skew), `ath` on redeem and capability use (and
  none on the token call), and each `jti` is recorded once for 120 s.
- **Binding.** Bindings are scoped by owner, channel and verified agent participant, so distinct verified
  sessions may coexist as distinct participants in one channel. A side-effect-free inspection resolves the
  session's participant before the handler checks that participant's binding and claims the durable session
  locator plus a participant-scoped pre-admission reservation. The same participant, session, generation and
  device get the same binding back; participant,
  session or device substitution is `409 binding_conflict`. Those checks run before admission, so a
  conflicting device never joins the channel.
- **Legacy migration.** Existing owner/channel singleton records are read compatibly and, when
  `legacyMigrationWritesEnabled` is active, roll forward to participant-scoped storage without changing the
  binding ID or losing revocation or current-capability state. Marker, locator or record mismatches fail
  closed. Marker-aware readers must be deployed everywhere before enabling migration writes; recovery after
  the first forwarding marker is roll-forward.
- **Revocation.** A revoked binding is never revived. KHA-128 moves a binding at generation `g` to its
  revoked generation `g + 1`, and that control-plane generation is authoritative. Re-bootstrapping at or
  below `g` is `409 binding_revoked`, before admission. The same participant, session and device at
  `g + 1` or later gets a new binding ID with its own capability, so a harness bumps its generation once
  after a revocation. Revoking one participant never changes another participant's binding or capability
  in the same channel.
- **Revocation ports (KHA-136).** `capabilities.lookupBinding(bindingId)` returns the owner, device, status
  (`active` or `revoked`) and authoritative generation (the revoked generation once revoked) for
  `RevocationTargets.lookup` and trust policy's `BindingStatus`. A replaced binding is `absent`.
  `capabilities.disableBinding` is the binding side of `RevocationControlPort.disable`: idempotent at the
  revoked generation, `stale` otherwise. The messaging device key is not held here; the composition root
  resolves it from the substrate.
- **Adapter capability.** 256-bit, stored hashed with a one-hour lifetime and bound to the connector key,
  the binding ID and its generation. Its scope is exactly `publish_own`, `receive_released` and
  `ack_delivery`: nothing approves, releases or sets policy. `capabilities.authorize(request, action)`
  accepts it only with a fresh proof for that request, and only while it is the binding's current
  capability. A later bootstrap of the same binding supersedes it, and `revokeAdapterCapability`
  (the shape of `RevocationControlPort.revokeAdapterCapability`) ends it.
- **Operation IDs.** The connector's `operation_id` claims only its one-time grant. Admission receives a
  stable private operation identity derived from owner, channel, participant, device, harness, session and
  generation. Independent grants for the same verified binding therefore converge on one idempotent
  admission commit, while unrelated bindings cannot collide.
- **Failures.** Responses are finite codes only. A throwing port becomes `503 unavailable`; an
  unknown admission outcome is `502 outcome_unknown`. The connector retries both with the
  same operation ID.

## Dependencies

| Input | Supplied by |
|---|---|
| `origin` | Exact https origin, e.g. `https://khala.aiur.team` |
| `store: ControlStore` | KHA-105 port; KHA-131 adapter |
| `authenticate` | KHA-110 `AuthService.authenticateRequest` (its `csrfToken` goes into the consent form) |
| `inviteFromLink(url)` | KHA-132 route codec (the share-link vocabulary is not fixed here) |
| `admissionFor(request)` | Request-scoped KHA-105 `AdmissionPort` for the signed-in owner (only `inspect` is used) |
| `admissionPolicy` | **G-ADMISSION.** It is required and has no default. It decides whether a signed-in holder of the link may bind an agent |
| `agents: AgentAdmissionPort` | `inspect({ ownerId, inviteRef, session })` resolves the verified session's exact channel and participant with no side effects. `admit` commits that expected participant and channel with the device, atomically rejects drift, and is idempotent per stable operation ID (KHA-113 / G-SUBSTRATE) |
| `legacyMigrationWritesEnabled` | Explicit rollout gate. Readers always understand legacy records and forwarding markers; set true only after every live reader is marker-aware |
| `clock`, `random` | Trusted time and a CSPRNG |

The gateway (`runtime/handler.ts`) requires `Origin` on POSTs. The connector sends the service's
own origin, and authority still comes only from the grant and proof.

## Not proven here

Tests use doubles for the store, auth and admission ports, and real Ed25519 signatures for
proofs. G-ADMISSION, G-SUBSTRATE and G-HARNESSES remain open. How the connector's device
signs in to the substrate is a G-SUBSTRATE decision made under the adapter capability, not here.
Real provider, Synapse and browser proof belongs to KHA-133/139.
