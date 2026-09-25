# OAuth-to-agent ownership bootstrap proof

KHA-144 feasibility evidence. This records one candidate trust path, implemented under `experiments/ownership/` and run against real software. It does not close G-ADMISSION, and it does not prove that an existing Claude or Codex session can be attached (KHA-103/104).

Recorded 2026-09-17 on Linux 7.1.4-arch1-1 x86_64, Node 24.18.0, pnpm 10.34.5, Docker 29.6.2. Exact dependencies: `oauth4webapi` 3.8.8 (relying party), `jose` 6.2.12 (JWT/JWK), `oidc-provider` 9.12.2 (disposable provider only), TypeScript 5.9.3. Synapse v1.161.0 and Postgres 16 come from KHA-102's digest-pinned compose file. Isolated lock SHA256: `fcb5ea640c2ace4e1b00ea7c4fdf7b6ac8c0d8b3b18832d1db1c983788e39809`.

## Candidate trust path

The agent's existing session runs a local owner endpoint. When the human pastes a channel link into that session, the endpoint:

1. Fetches the link's public descriptor.
2. Creates or loads its persistent Ed25519 key.
3. Opens the owner's default browser at the Khala bind URL. The URL carries an RFC 8252 loopback redirect, a PKCE challenge, the key thumbprint and the harness session ID and generation.

The owner's existing Khala sign-in cookie is the owner evidence. The browser redirects a one-time code to the endpoint's loopback listener. The endpoint then:

1. Exchanges the code for a 60-second bootstrap token, using a DPoP-shaped proof signed by its key.
2. Redeems the token once for an agent binding and a narrow adapter token.
3. Uses a 60-second device-login assertion to create its own Matrix device.

`experiments/ownership/README.md` lists each authority transition with its producer and verifier.

This answers the plan's critical unknown ("which existing mechanism supplies trusted session evidence"):

- **Owner authority:** the Khala session cookie. It is `HttpOnly`, `SameSite=Lax` and 8 hours in this proof, and it comes from provider sign-in (issuer/subject). The public link supplies none.
- **Existing session evidence:** the local process's claim of `{harness, id, generation}`, delivered on the owner's own machine. Khala cannot verify that this is the human's existing working session. It trusts whatever process can listen on loopback and open the browser as the owner's OS user. Proving the claim belongs to KHA-103/104.
- **Scoped token verifier:** the ownership boundary (`src/binding.ts`). It checks issuer, audience, expiry (no clock tolerance), proof key thumbprint, proof method/URL/`ath`/`jti`, session generation, and the replay record keyed by token `jti` and operation ID.

## Observed results

`pnpm test` (offline, 14/14 pass, about 3.5 s) runs a real disposable OIDC provider, real HTTP, real loopback redirects and real signatures. Matrix accounts are an in-memory double, so these results prove module behaviour, not provider capability.

`pnpm test:live` (1/1 pass, zero skips, 31–33 s over two runs) replaces the double with real Synapse/Postgres.

| Scenario | Where | Result |
| --- | --- | --- |
| OAuth sign-in → channel → existing session bound → endpoint-created agent device joins and sends in the channel | live | pass |
| Agent Matrix user is distinct from the human's; the endpoint, not the control plane, holds its device token | live | pass |
| Human-visible steps: only sign-in, "New channel", paste link | live + offline | pass (listed below) |
| Copied link opened by a stranger's machine and browser: no binding, owner browser times out | live + offline | pass |
| Stranger signs in as themselves: the binding carries their owner ID, never the creator's | offline | pass |
| Non-loopback, `localhost`, portless or userinfo redirect refused; untrusted link origin refused by endpoint | offline | pass |
| Code is one-time; wrong PKCE verifier, wrong key, substituted generation rejected | offline | pass |
| Bootstrap token: wrong audience, expired, replayed proof, replay under a new operation ID, substituted generation, thief key all rejected | offline | pass |
| Lost redeem response: retry with the same operation ID returns the recorded outcome and leaves one binding and one agent account | offline | pass |
| Another session of the same owner cannot silently take over the channel binding (409) | offline | pass |
| Adapter capability cannot call `approve_release` or `set_policy` (403); the human approval route rejects a bearer credential and a request without CSRF (401) | live + offline | pass |
| A self-signed device-login assertion for the human account is refused by Synapse (403) | live | pass |
| Missing harness session is reported as `harness_session_missing`; no browser opens and no fresh session is created | offline | pass |
| Same issuer/subject keeps one owner and one Matrix account through a provider email change | live + offline | pass |
| Lost Synapse create response reconciles to exactly one account through the admin `external_ids` lookup | live | pass |
| Browser `/api/human/me` projection carries identifiers only: no access, adapter or login tokens and no keys | live + offline | pass |

Human-visible actions recorded by the live run:

1. Click "Sign in" on Khala.
2. Enter email and password at the identity provider.
3. Click "New channel".
4. Copy the channel link and paste it into the existing agent session.

The browser also briefly shows a loopback "Your agent is connected" tab. There is no CLI, install, MCP, Matrix account or key ceremony for the human. Starting the endpoint inside the session is the harness adapter's job, which is not proven here.

## G-ADMISSION remains open

The candidate binds **silently**: an owner who is already signed in sees no confirmation. The approach is safe against remote attackers, because the code only reaches a loopback listener on the owner's machine, and the endpoint key constrains it. It is not safe against **any local process running as the owner's OS user**, which can open the bind URL and receive a binding. Choosing between that and a single visible browser confirmation is the product gate. It was raised as `decision.requested` `dec_b256c782b532af43`, with the recommendation: automatic on the same machine plus a one-click fallback for remote agents. The code takes an `admission` policy hook but decides nothing. By default, any signed-in human holding the link can bind *their own* agent to the channel, which is KHA-113's coworker question.

Unsupported by this path, and reported rather than worked around:

- An agent on a different machine from the owner's browser. The loopback redirect cannot reach it. This needs the fallback above or a device-authorization-style flow.
- A harness that cannot supply a session ID and generation.
- Re-binding a channel to another session. This returns `binding_conflict`, so an explicit owner re-pair flow is needed.

## Costs for KHA-105/110/113

- **Libraries:** `oauth4webapi` and `jose`, both maintained and zero-dependency. `oidc-provider` is test-only. There is no custom crypto: Ed25519 and ES256 come through WebCrypto via `jose`.
- **Synapse:** `jwt_config` with an ES256 public key (the pinned image ships the needed `authlib`), and one admin access token held server-side for `PUT /_synapse/admin/v2/users` and the `auth_providers/{id}/users/{external_id}` lookup. The admin token never reaches a browser or endpoint. The control plane never holds an endpoint's Matrix access token or crypto keys, although its device-login key could mint devices for any Khala user and must be protected.
- **Control-plane state:** pending codes (60 s), used proof `jti`s, redemption records and bindings. In this proof they live in memory, so production needs a durable store with TTLs.
- **Origin:** production links and the callback use `https://khala.aiur.team` and `/api/human/auth/callback`. The proof runs on loopback HTTP, and `Secure` cookies apply only on HTTPS origins.

## Limits

- Mocked accounts in the offline suite prove only module behaviour.
- The disposable IdP stands in for the real provider. Provider choice and consent screens are outside this ticket.
- The DPoP-shaped proof borrows RFC 9449 semantics but is not a certified implementation.
- The proof does not implement verified-device crypto trust, which is KHA-141/142's evidence.

Evidence contains no message bodies, raw tokens or private keys. The live run's diagnostics record versions, duration, human actions and redacted page paths only.
