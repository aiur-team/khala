# `@khala/control/agent-bootstrap`

Hosted side of agent-operated link bootstrap (KHA-114), following the trust path
KHA-144 proved. Import `createAgentBootstrapHandlers` from `@khala/control/agent-bootstrap/handler`.
It returns route registrations for both domains. KHA-132 composes `human`, and KHA-133
composes `agent`.

| Route | Caller | Authority |
|---|---|---|
| `GET /api/agent/bootstrap/descriptor?link=` | Connector | None. It returns the invite, `loopback-browser-v1` and the fixed endpoints. It does not reveal whether the invite exists |
| `GET /api/human/agent-bootstrap/authorize` | Owner's browser | The owner's Khala session cookie. Signed-out browsers go to sign-in and back |
| `POST /api/agent/bootstrap/token` | Connector | One-time code (60 s) + PKCE S256 + key proof → 60 s grant |
| `POST /api/agent/bootstrap/redeem` | Connector | `Authorization: DPoP <grant>` + key proof with `ath` → `SessionBinding` + device credential |

## Guarantees

- **Owner.** The owner comes only from `authenticate(request)`. Link possession, email, display
  names and agent claims carry no authority. A forwarded link opened by someone else binds
  *their* agent under *their* owner ID, never the creator's.
- **Redirect.** Only an RFC 8252 loopback redirect is accepted: `http`, `127.0.0.1` or `[::1]`, an explicit port, and
  no userinfo, query or fragment. `localhost` is refused. A bad redirect gets a 400, never a redirect.
- **Codes and grants.** Each is a 256-bit random value, stored only under a purpose-separated hash with a
  60 s expiry. A code is consumed before its verifier, session, device and key are checked, so a
  wrong attempt burns it. A grant is claimed by the first `operation_id`; only a lost-response
  retry of that same operation may present it again (`grant_replayed` otherwise).
- **Proofs.** Compact EdDSA JWS (`typ: dpop+jwt`) with the embedded Ed25519 key. Its RFC 7638
  thumbprint must equal the bound `jkt`. It is checked with `node:crypto` for exact `htm`/`htu`,
  `iat` within 60 s (5 s skew) and `ath` on redeem, and each `jti` is recorded once for 120 s.
- **Binding.** There is one immutable binding per owner and room. The same session, generation and device get the
  same binding back. Any other session or generation is `409 binding_conflict`. That check runs
  before admission, so a conflicting device never joins the room. Rebinding is an explicit owner
  flow, not a reconnect.
- **Operation IDs.** The connector's `operation_id` only ever reaches `admit` hashed together with the
  owner and device, so two owners cannot collide on a chosen ID.
- **Scope.** The grant admits one device for one session. It cannot approve, release or set
  policy, and the redeem route ignores human cookies.
- **Failures.** Responses are finite codes only. A throwing port becomes `503 unavailable`; an
  unknown admission outcome is `502 outcome_unknown`. The connector retries both with the
  same operation ID.

## Dependencies

| Input | Supplied by |
|---|---|
| `origin` | Exact https origin, e.g. `https://khala.aiur.team` |
| `store: ControlStore` | KHA-105 port; KHA-131 adapter |
| `authenticate` | KHA-110 `AuthService.authenticateRequest` |
| `inviteFromLink(url)` | KHA-132 route codec (the share-link vocabulary is not fixed here) |
| `admissionFor(request)` | Request-scoped KHA-105 `AdmissionPort` for the signed-in owner (only `inspect` is used) |
| `admissionPolicy` | **G-ADMISSION.** It is required and has no default. It decides whether a signed-in holder of the link may bind an agent, and whether that happens silently |
| `agents: AgentAdmissionPort` | `room(invite)` resolves the room with no side effects. `admit` adds the owner's agent participant, with this device, to that room, idempotently per (scoped) operation ID (KHA-113 / G-SUBSTRATE) |
| `devices: DeviceCredentialPort` | Short-lived substrate credential for exactly this device (for example a JWT login). Reissuing never creates a second device |
| `clock`, `random` | Trusted time and a CSPRNG |

The gateway (`runtime/handler.ts`) requires `Origin` on POSTs. The connector sends the service's
own origin, and authority still comes only from the grant and proof.

## Not proven here

Tests use doubles for the store, auth, admission and device ports, and real Ed25519
signatures for proofs. G-ADMISSION, G-SUBSTRATE and G-HARNESSES remain open. Real
provider, Synapse and browser proof belongs to KHA-133/139.
