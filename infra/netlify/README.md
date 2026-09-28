# Netlify packaging (KHA-131)

Deploys `apps/web` as a static SPA and `apps/control` as Netlify Functions from
one workspace-root build. See the [canonical plan](../../docs/plans/2026-09-16-kha-131-netlify-deployment-plan.md)
for the full design and [`docs/product/repo-layout.md`](../../docs/product/repo-layout.md)
for ownership boundaries.

## Layout

- `netlify.toml` (repo root) — build command, publish directory, functions
  directory, redirects and headers.
- `infra/netlify/env.schema.json` — documents the public/server environment
  variable contract. Netlify does not read this file; it is a reference for
  operators and for `control-store-live-check.ts`.
- `infra/netlify/functions-generated/` — **generated, gitignored.** Produced
  by `pnpm --filter @khala/control build:functions`
  (`apps/control/src/runtime/discover.ts`). This is Netlify's functions
  **input** directory, not its internal build output. Never hand-edit files
  here; they are overwritten on every build.
- `infra/netlify/control-store-live-check.ts` — isolated live-Blobs
  conformance check for the control-store adapter. Never run against a
  production site; see its own `--environment` guard.

## Build

```sh
pnpm install --frozen-lockfile
pnpm --filter @khala/control build:functions   # emits infra/netlify/functions-generated/
pnpm --filter @khala/web build                 # emits apps/web/dist
```

Netlify runs exactly this sequence (see `[build.command]` in `netlify.toml`).
A missing or malformed function producer (`apps/control/src/composition/{human,agent}/handlers.ts`)
fails `build:functions` with a specific error rather than silently shipping a
broken function; an *absent* producer module (the file doesn't exist yet) is
not an error — its routes are simply omitted and return `503
feature_unavailable` at runtime, so this ticket can ship before KHA-132/133
land their producers.

## Environment variables

Two disjoint groups, enforced by `infra/netlify/env.schema.json`:

- **Public** (`PUBLIC_*`) — inlined into the browser bundle. Safe to appear in
  client-side JavaScript. Set per Netlify deploy context.
- **Server** — read only inside a function's request handling (never at
  module import time), never logged, never echoed in a response body.

Production's `PUBLIC_APP_ORIGIN` is `https://khala.aiur.team` in both
`netlify.toml` for the build and the Netlify site's Functions-scoped production
environment for the control runtime. Netlify does not expose `netlify.toml`
environment variables to Functions. The OAuth callback is
`https://khala.aiur.team/api/human/auth/callback`.
Set `PUBLIC_HOMESERVER_ORIGIN` to the operator-provisioned Railway Synapse HTTPS
origin (a bare origin such as `https://matrix.example.com`, no path); it is
configuration, not an endpoint inferred or embedded by the app, and it is the
only non-self origin the CSP's `connect-src` admits.
Preview and branch deploys get their own Netlify-assigned origin and must use
separate OAuth client credentials and a separate `CONTROL_STATE_NAMESPACE` —
Netlify Blobs stores are shared across deploy contexts on a site, so
namespacing by `CONTROL_STATE_NAMESPACE` (not just by convention) is what
actually keeps preview writes out of production state. Untrusted preview code
must run on a separate Netlify site with its own credentials, not just a
separate namespace on the production site.

The human control runtime additionally requires `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `MATRIX_SERVER_NAME`,
`MATRIX_REGISTRATION_SHARED_SECRET`, `MATRIX_PASSWORD_DERIVATION_SECRET` and
`INVITATION_HMAC_SECRET`. All are context-scoped server variables except the
public homeserver origin. Under P17, the control runtime derives a stable
per-owner password, registers through Synapse's nonce/HMAC shared-secret
endpoint, exchanges the password server-side for a device access token, and
returns only that token. Keep the two Matrix secrets independent and at least
32 characters; neither secret nor the derived password may enter browser code.
For an isolated Matrix ingress, set the separate server-only
`MATRIX_REGISTRATION_INGRESS_TOKEN` on the Netlify site and the matching
`KHALA_REGISTRATION_INGRESS_TOKEN` at ingress. Only the registration nonce and
HMAC requests carry it; the ingress strips it before forwarding to Synapse.
The production `https://khala.aiur.team` origin opts into explicit browser
consent for agent admission. Other origins require
`KHALA_ADMISSION_MODE=explicit_browser_consent`; an explicitly invalid value
still fails closed. This code-level production opt-in is necessary because the
current Netlify CLI identity can read this site's environment but the API
rejects environment writes with `Forbidden`.

In the explicit mode, `GET /api/human/channel-access/inbox` uses the signed-in
owner session and the durable control-state namespace. A signed-out request
returns 401 and an owner with no requests receives an empty 200 response.
For stored requests, Control rechecks the recorded room owner and live Matrix
membership before showing the row; unavailable or changed authority returns 503.
Channel-access request, decision, mute, exchange, readiness and resume still
return 503 until hosted agent authentication, channel resolution and Matrix
admission adapters are composed. The inbox does not approve or admit an agent.

## Routing

The site root `/` alone is force-rewritten to the public splash page,
`apps/web/dist/landing/index.html`, built by the last step of
`pnpm --filter @khala/web build` (`apps/web/vite.landing.config.mjs`, source in
`apps/web/src/landing/`). It owns its own output directory and never writes
`dist/index.html` or `dist/assets`, so it cannot collide with the app entry.
The rule sits after `/api/*` and before the SPA fallback, and it needs
`force = true` because Netlify otherwise serves an existing `dist/index.html`
at `/` without consulting the rule.

`/api/*` rewrites to the generated control function before the SPA fallback is
considered, so a reload on a deep link (for example, a shared channel) serves
`index.html` while an API error stays a structured JSON response — never HTML.
Direct invocation of the Netlify function URL
(`/.netlify/functions/khala-control/...`) is normalized back to the same
`/api/...` path inside the handler, so it cannot bypass route, method, or auth
validation.

## What the deployment boundary does not do

- It does not implement `apps/control/src/composition/agent/handlers.ts`
  (KHA-133 owns that producer).
- It does not declare the Content-Security-Policy in `netlify.toml`, which
  cannot interpolate an environment variable. `pnpm --filter @khala/web build`
  writes `apps/web/dist/_headers` with `connect-src 'self' <PUBLIC_HOMESERVER_ORIGIN>`
  (`apps/web/src/composition/human/hosted-config.ts`). A malformed origin fails
  the build; a missing one keeps `connect-src 'self'`, and the app then shows an
  explicit "Khala is unavailable" screen instead of a blank page.
- It does not run `control-store-live-check.ts` against real credentials —
  that requires a provisioned preview Netlify site and Blobs store, which is
  an external deployment gate.
