# Disposable local OIDC preflight for KHA-134

This overlays `infra/messaging/compose.yaml` with a **local-only** Dex issuer. It proves the selected Synapse/Postgres package and a real OIDC authorization-code flow before any Railway or Netlify resource is created. It is not the hosted KHA-134 acceptance environment: Dex uses disposable in-memory storage, its issuer is plain HTTP on loopback, and no Netlify app is deployed. Never point it at production.

Dex is pinned to `ghcr.io/dexidp/dex:v2.43.1@sha256:0881d3c9359b436d585b2061736ce271c100331e073be9178ef405ce5bf09557`. The renderer accepts only an HTTPS issuer/callback, except for exact loopback HTTP during this preflight, and requires two distinct verified-email users with bcrypt cost at least 10. Dex's local password form has an `email address` placeholder, a `Password` label, and a `Login` button. Its visible email label is not associated with the input, so the live descriptor's optional `usernamePlaceholder` must be set to `email address` until that upstream form changes. Verify the actual hosted form before running the suite.

Create a new private temporary directory and export the variables below with fresh disposable values. Do not save secrets in the checkout, commit a rendered config, or print the environment. Use `mkpasswd -m bcrypt -R 10 -s` (password on stdin) to generate each user hash. The two plain passwords go only to the live-test credential environment and the operator's private temporary record; Dex receives the hashes.

```text
KHALA_PREVIEW_OIDC_ISSUER=http://127.0.0.1:<unused-port>/dex
KHALA_PREVIEW_OIDC_CALLBACK=http://127.0.0.1:<unused-callback-port>/api/human/auth/callback
KHALA_PREVIEW_OIDC_CLIENT_ID=<unique-disposable-client-id>
KHALA_PREVIEW_OIDC_CLIENT_SECRET=<fresh-32-plus-character-secret>
KHALA_PREVIEW_OIDC_CONFIG_DIR=<absolute-private-directory>
KHALA_PREVIEW_OIDC_USER_A_EMAIL=<test-email-a>
KHALA_PREVIEW_OIDC_USER_A_BCRYPT_HASH=<bcrypt-cost-at-least-10>
KHALA_PREVIEW_OIDC_USER_A_ID=<uuid-a>
KHALA_PREVIEW_OIDC_USER_B_EMAIL=<test-email-b>
KHALA_PREVIEW_OIDC_USER_B_BCRYPT_HASH=<bcrypt-cost-at-least-10>
KHALA_PREVIEW_OIDC_USER_B_ID=<uuid-b>
KHALA_PREVIEW_DEX_PORT=<same-unused-port-as-issuer>
```

Set the separate `KHALA_*` preview variables documented in `infra/messaging/railway.md`, including a **unique** `KHALA_STATE_NAMESPACE` ending `-preview`, private `KHALA_CONFIG_DIR`, and fresh Synapse/Postgres secrets. Then:

```sh
node infra/messaging/check.ts --environment preview --render-only
node infra/preview/render-dex.ts
docker compose -p "$KHALA_STATE_NAMESPACE" \
  -f infra/messaging/compose.yaml -f infra/preview/compose.yaml config --quiet
docker compose -p "$KHALA_STATE_NAMESPACE" \
  -f infra/messaging/compose.yaml -f infra/preview/compose.yaml up -d --wait
```

Discover Synapse's loopback port with `docker compose -p "$KHALA_STATE_NAMESPACE" -f infra/messaging/compose.yaml -f infra/preview/compose.yaml port synapse 8008`; set `KHALA_MATRIX_CHECK_ORIGIN=http://127.0.0.1:<that-port>` and `KHALA_ALLOW_INSECURE_LOOPBACK=true`, then run `node infra/messaging/check.ts --environment preview`. Set `KHALA_PREVIEW_OIDC_USER_A_PASSWORD` to the disposable password corresponding to user A's bcrypt hash, then run `node infra/preview/smoke-oidc.ts`. The smoke drives a real browser login, S256 PKCE code exchange, JWKS signature check, nonce, issuer, audience and verified email; it prints only a sanitized result. Discovery alone is insufficient. The repo's Playwright browser must be installed.

The local Synapse process reads the secret-bearing config file as UID 991 after `synapse-data-init` owns the volume; Dex reads its direct-mounted config as UID 1001. This does **not** prove Railway's secret-file delivery or ingress restriction. Those provider-specific gates remain in the external preview plan. No production Synapse configuration changes are made here.

After recording only sanitized results, remove the one project and its volumes:

```sh
docker compose -p "$KHALA_STATE_NAMESPACE" \
  -f infra/messaging/compose.yaml -f infra/preview/compose.yaml down --volumes
```

Remove the private temporary config and credential directory once the proof is complete. The human Playwright suite still requires an actual HTTPS Netlify/Railway deployment. Its creator session now supplies raw ciphertext evidence; the separate observer account proves that an unadmitted user is denied. This does not inspect Synapse database or logs for the separate security acceptance.

Local evidence, 2026-09-27: Node 24.18.0 and Docker Engine 29.6.2 ran a unique project `khala-134-5eabb4-preview`, with no pre-existing containers. The messaging checker returned `boundary-checks-pass`; Dex v2.43.1 discovery advertised S256, its JWKS held one RS256 key, and a real authorization-code/S256 exchange returned an ID token whose signature, issuer, nonce, verified email and email claim checked. A separate real Synapse private room returned 200 to its owner and 403 to an unadmitted observer at `/messages`. The initial trial exposed Dex's bcrypt minimum cost of 10; the renderer now rejects weaker hashes. This local run must not be cited as hosted proof.

## Disposable external application topology

From the repository root, with Docker, `unshare`, `socat`, `openssl`, `mkpasswd`,
Node, pnpm, Netlify CLI 27.1.2 and Playwright Chromium installed, run:

```sh
pnpm test:external:local
```

This command creates a fresh private directory and Compose project, builds the
production web, generated control function and CLI bundle, and serves them
through Netlify Dev behind a trusted loopback HTTPS origin. It runs the hosted
`explicit_browser_consent` registration and checks the generated hosted agent
bootstrap route before browser work begins. It runs the hosted
human browser suite with real Dex authorization-code/PKCE sign-in, session
cookies, channel sharing, encrypted Matrix events, and a read-only outsider.
It then checks a persisted auth-session record in local Blobs emulation from a
fresh browser after a function restart. It runs the locally installed hosted
CLI's `status` and `channels open` commands, then probes installed hosted
connector startup through a prejoin MCP call using the same origin and private
profile. The probe requires an MCP initialization reply, an exact pending-owner
approval result, and the new session's private hosted state directory. The
result is reported separately as `connectorStartup`; an unproven candidate
does not prevent the verified topology or downstream `--exec` from running.
When startup is unproven, `connectorDiagnostic` includes only fixed protocol
and hosted-opening stage codes, so an `internal_error` can be investigated
without copying raw child output or secrets. Owner approval and native
read/write belong to #811. It reports only
a stage, correlation ID, artifact digests, versions and scope names. Raw child
and browser output stays private and the runner removes only its own project,
volumes and private files. `KHALA_LOCAL_AUTH=enabled`, fixture credentials and
HTTP or production origins are rejected.

The installed Netlify CLI's bundled local Blobs server omits GET ETags needed
by the control store's compare-and-set confirmation. The runner patches that
local adapter for its spawned CLI process only and refuses an unrecognized
adapter version. Its temporary Netlify config adds HTTPS with a per-run
certificate so the function sees the same HTTPS callback URL as the browser.
This is local provider emulation, not deployed Netlify or Google proof.

For a downstream test that needs the live topology, append `--exec` and a
command to the runner: `node infra/preview/external-local.mjs --exec <command>
<args...>`. The child receives `KHALA_E2E_DISPOSABLE_ENV` (an absolute,
secret-free descriptor), `KHALA_E2E_LIVE=1`, the two disposable user credential
variables named by that descriptor, `KHALA_E2E_MATRIX_OBSERVER_TOKEN`,
`NODE_EXTRA_CA_CERTS`, `KHALA_E2E_CERT_SPKI`, `KHALA_EXTERNAL_CLI` (the installed
bundle path), and `KHALA_EXTERNAL_ORIGIN`. The child runs after the topology
smoke and before teardown. Its environment is limited to these consumer values,
`KHALA_APP_ORIGIN`, private `HOME`/`TMPDIR`/XDG/CODEX roots, and basic process settings; it does not
inherit the Dex, Matrix registration, database, or HMAC secrets. This interface
provides the substrate for #811; it
does not produce model-visible native receipts or claim three-party acceptance.
