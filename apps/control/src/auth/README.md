# `@khala/control/auth`

Human OAuth sign-in, sessions and owner → messaging identity mapping (KHA-110). Import from
`@khala/control/auth/index`. The module owns no HTTP server or storage adapter.
`createAuthService` receives them, together with the OIDC client:

| Input | Supplied by |
|---|---|
| `oidc: OidcClient` | `createOidcClient({ issuer, clientId, clientSecret?, clock? })` from `@khala/control/auth/oidc`, the adapter over `oauth4webapi` 3.8.8 (the KHA-144 pin). See below |
| `store: ControlStore` | The KHA-105 port. KHA-131 supplies the persistence adapter |
| `messaging: MessagingAccountDirectory` | The selected substrate's server-side account directory (G-SUBSTRATE) |
| `clock`, `random` | Trusted time and a CSPRNG |
| `origin` | The exact https origin, for example `https://khala.aiur.team`. The callback is always `${origin}/api/human/auth/callback`. Each preview origin gets its own service instance and provider registration |
| `sessionTtlMs`, `loginTtlMs` | Configured policy. There is no default, so the deployment records its choice |

## OIDC adapter

`createOidcClient` discovers the issuer's metadata (the returned `issuer` must match
exactly) and caches it only after a success. It builds an authorization-code URL with
`scope=openid email`, state, nonce and an S256 challenge, and refuses any other PKCE
method. On the callback, `oauth4webapi` validates the authorization response against the
expected state, redeems the code with the PKCE verifier and the exact redirect URI, and checks
the ID token's issuer, audience, expiry and nonce. The adapter then verifies the ID token
signature against the issuer's JWKS. When the ID token has no `email` or `email_verified`,
the adapter takes both from userinfo, and only when the userinfo `sub` equals the ID token
`sub`. A confidential client authenticates with HTTP Basic. Tokens never leave the adapter.

The provider's refusals are `rejected` (`denied` for `access_denied`, otherwise
`invalid_response`). Network errors, timeouts, discovery failures and 5xx responses are
`unavailable`. The client ID, secret and issuer are runtime bindings owned by KHA-131.

## Route bindings

The request-lifetime functions (KHA-131/132) bind the service to routes:

- `GET /api/human/auth/login?return_to=<path>` → `startSignIn(path)`. Set `cookies` and redirect to `location`.
- `GET /api/human/auth/callback` → `completeSignIn(request)`. Set `cookies` on every result.
  On `signed_in`, redirect to `location`, which is always the stored same-origin path.
  Render `unavailable` as a retryable error, never as signed out.
- Read routes → `authenticateRequest(request)`. `context.csrfToken` goes to the page, for
  example in `/api/human/me`, so it can send `x-khala-csrf` on mutations.
- Mutation routes → `requireHumanMutation(request)` before reading the body. Take the owner
  only from `context.principal`, never from a body `ownerId` or email.
- `POST /api/human/auth/logout` → `signOut(request, operationId)`. On `outcome_unknown`,
  retry with the same `operationId`. The ID is scoped to the session before it reaches
  the store, so an ID reused across sessions cannot collide.

`identityFor(request)` wraps these as the KHA-105 `IdentityPort`. That port has no refusal
code, so a sign-out through a request that fails the mutation guard reports `unavailable`
and leaves the session untouched.

## Guarantees

- **Identity.** The owner is keyed by issuer + subject. A verified email change keeps the
  owner, and the same email at another issuer is a different owner. There is no account
  linking. `ownerId` is random and never email-shaped. Claims are re-checked after the
  library: exact `iss`, `aud` (with `azp` when there are several audiences), `exp`, the
  login's `nonce` (constant-time), a bounded `sub`, and `email_verified === true` (the
  string `"true"` fails).
- **Tokens.** Session and login tokens are 256-bit random values held only in
  `__Host-` cookies that are `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`. The store
  keeps purpose-separated SHA-256 hashes only. The CSRF token is a separate hash of the
  session token, so a page can hold it without learning the cookie.
- **Callback.** The login binding (state, nonce, PKCE verifier, return path) is keyed by the
  hash of the login cookie. A callback must present that cookie, the matching `state`
  (compared in constant time) and the exact callback URL. A mismatched callback leaves the login cookie in place, so a
  forged link cannot cancel a sign-in in progress. The binding is consumed by compare-and-set before the code is
  exchanged, so concurrent replays produce at most one session. A session is minted only
  after the claims pass, the owner resolves and the messaging mapping is active. A new
  sign-in revokes the session this browser already held. This is best effort: if the
  revoke cannot be written, the old session still expires on its own.
- **Failure categories.** `signed_out` (no valid session), `rejected` (a finite code) and
  `unavailable` (store, provider or messaging failure) stay distinct. A thrown adapter
  error becomes `unavailable`, and its message is never propagated.
- **Provisioning.** The mapping moves `pending` → `active`. A lookup by the owner ID
  (the external ID) precedes every create, so a lost create response is adopted rather
  than duplicated. The directory's `create` must converge per external ID (a
  deterministic account name with create-or-update). When a competing activation won,
  the directory is re-checked, and the result is `conflict` only if it disagrees. The
  mapping stores only the protocol account ID: no access token, password or crypto
  secret. Signing in is not message-key recovery.
- **Diagnostics.** `log` receives `{ event, code, requestId }` only. The request ID comes
  from `x-nf-request-id` or `x-request-id` and is dropped unless it is a short plain
  identifier.

## Not proven here

The tests use injected doubles, so they prove module behaviour only. The adapter tests run
`oauth4webapi` against an in-process authorization server that signs real ES256 ID tokens.
They do not show that a real provider, store or messaging substrate behaves this way. KHA-132 proves the real browser
journey. G-ADMISSION and G-SUBSTRATE are still open, and nothing here decides them.
