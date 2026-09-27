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
