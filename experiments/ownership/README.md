# OAuth-to-agent ownership bootstrap proof (KHA-144)

This experiment shows how a public chat link can connect to the owner's existing agent session. The human does no technical setup, and a copied link cannot claim the owner's identity. It is feasibility code, not a production auth service. Results and open gates are in `docs/evidence/ownership.md`.

```sh
pnpm --dir experiments/ownership install --frozen-lockfile
pnpm --dir experiments/ownership build
pnpm --dir experiments/ownership test
pnpm --dir experiments/ownership test:live
```

Node 24.18 or newer runs the TypeScript sources directly. `test` needs no network or Docker. `test:live` needs local Docker and starts a disposable Synapse/Postgres with KHA-102's pinned `experiments/backend/compose.yaml`, used read-only. That run also uses this experiment's own homeserver config with JWT login enabled. Containers, volumes, config and endpoint stores are removed after the run.

## Candidate trust chain

| Step | Authority | Producer | Verifier |
| --- | --- | --- | --- |
| Human signs in | Provider `iss`+`sub` → Khala owner | OIDC provider (disposable `oidc-provider` here), authorization code + PKCE + nonce | `src/identity.ts` relying party (`oauth4webapi`) |
| Human browser session | Khala owner | `HttpOnly SameSite=Lax` cookie; mutations also need a CSRF header | `HumanSessions` |
| Chat link | Room reference only, no authority | `POST /api/human/chats` by a room member | `GET /c/:link` returns a descriptor with no owner, room ID or secret |
| Existing session → endpoint | Harness session ID and generation, endpoint key thumbprint | Local endpoint (`src/endpoint.ts`) run by the existing session | Taken as a claim; KHA-103/104 own proving it |
| Owner binding | Owner + room + session + endpoint key | The owner's already signed-in browser at `/api/agent/bind`, redirected to an RFC 8252 loopback URI with PKCE | `OwnershipBoundary.authorize`: session cookie, loopback redirect, admission policy, conflict check |
| Bootstrap token | One-time, 60 s, audience `khala:owner-endpoint-bootstrap`, `cnf.jkt` | `exchange` after the PKCE verifier and a DPoP-shaped proof check | `redeem`: issuer, audience, expiry, proof key, session generation, replay record |
| Adapter capability | `publish_own receive_released ack_delivery` only | `redeem` | `authorizeAgentAction`: sender-constrained, binding still current, capability granted |
| Matrix device | Agent account, distinct from the human's | The endpoint logs in itself with a 60 s ES256 `org.matrix.login.jwt` assertion | Synapse `jwt_config`, which holds only the public key |

The public link never reaches `authorize` as owner evidence. Without the owner's browser cookie, the bind URL redirects to provider sign-in. If the stranger then signs in, the binding they get is for their own identity.

## Layout

- `src/identity.ts`: OIDC relying party, stable `iss`/`sub` owner directory, human cookie sessions.
- `src/provisioning.ts`: idempotent account preparation keyed by external ID (Synapse admin route, server side only) and the device-login assertion issuer.
- `src/binding.ts`: the ownership boundary (codes, tokens, replay, conflicts, capabilities, projection).
- `src/control.ts`: disposable control-plane HTTP surface, standing in for `https://khala.aiur.team` functions.
- `src/endpoint.ts`: owner endpoint (persistent Ed25519 key, loopback listener, redeem with retry, Matrix device login).
- `src/idp.ts`, `src/browser.ts`: test infrastructure. A disposable OpenID Provider, and a cookie-carrying browser that records human-visible actions.

`tests/identity.test.ts` and `tests/binding.test.ts` replace Matrix with an in-memory account double. They prove module behaviour only. `tests/journey.test.ts` is the live proof.
