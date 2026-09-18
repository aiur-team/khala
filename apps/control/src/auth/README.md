# `@khala/control/auth`

Human OAuth sign-in, sessions and owner → messaging identity mapping (KHA-110). Import from
`@khala/control/auth/index`. The module owns no HTTP server, provider library or storage
adapter. `createAuthService` receives all of them:

| Input | Supplied by |
|---|---|
| `oidc: OidcClient` | An adapter over a maintained OIDC client. KHA-144 pinned `oauth4webapi` 3.8.8. The adapter validates discovery, the code exchange, the ID token signature and the nonce |
| `store: ControlStore` | The KHA-105 port. KHA-131 supplies the persistence adapter |
| `messaging: MessagingAccountDirectory` | The selected substrate's server-side account directory (G-SUBSTRATE) |
| `clock`, `random` | Trusted time and a CSPRNG |
| `origin` | The exact https origin, for example `https://khala.aiur.team`. The callback is always `${origin}/api/human/auth/callback`. Each preview origin gets its own service instance and provider registration |
| `sessionTtlMs`, `loginTtlMs` | Configured policy. There is no default, so the deployment records its choice |

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
  retry with the same `operationId`.

`identityFor(request)` wraps these as the KHA-105 `IdentityPort`. That port has no refusal
code, so a sign-out through a request that fails the mutation guard reports `unavailable`
and leaves the session untouched.

## Guarantees

- **Identity.** The owner is keyed by issuer + subject. A verified email change keeps the
  owner, and the same email at another issuer is a different owner. There is no account
  linking. `ownerId` is random and never email-shaped. Claims are re-checked after the
  library: exact `iss`, `aud` (with `azp` when there are several audiences), `exp`, a
  bounded `sub`, and `email_verified === true` (the string `"true"` fails).
- **Tokens.** Session and login tokens are 256-bit random values held only in
  `__Host-` cookies that are `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`. The store
  keeps purpose-separated SHA-256 hashes only. The CSRF token is a separate hash of the
  session token, so a page can hold it without learning the cookie.
- **Callback.** The login binding (state, nonce, PKCE verifier, return path) is keyed by the
  hash of the login cookie. A callback must present that cookie, the matching `state` and
  the exact callback URL. The binding is consumed by compare-and-set before the code is
  exchanged, so concurrent replays produce at most one session. A session is minted only
  after the claims pass, the owner resolves and the messaging mapping is active.
- **Failure categories.** `signed_out` (no valid session), `rejected` (a finite code) and
  `unavailable` (store, provider or messaging failure) stay distinct. A thrown adapter
  error becomes `unavailable`, and its message is never propagated.
- **Provisioning.** The mapping moves `pending` → `active`. A lookup by the owner ID
  (the external ID) precedes every create, so a lost create response is adopted rather
  than duplicated. If a competing activation disagrees, the result is `conflict`. The
  mapping stores only the protocol account ID: no access token, password or crypto
  secret. Signing in is not message-key recovery.
- **Diagnostics.** `log` receives `{ event, code, requestId }` only. The request ID comes
  from `x-nf-request-id` or `x-request-id` and is dropped unless it is a short plain
  identifier.

## Not proven here

The tests use injected doubles, so they prove module behaviour only. They do not show that a
real provider, store or messaging substrate behaves this way. KHA-132 proves the real browser
journey. G-ADMISSION and G-SUBSTRATE are still open, and nothing here decides them.
