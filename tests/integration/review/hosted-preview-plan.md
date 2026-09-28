# Disposable hosted #43 proof packet

This is a resource and evidence plan, not a deployment record. The current
Railway `khala` project has only `production`, and Netlify has only the
`khala-aiur` site. Neither is a disposable acceptance target. Follow
[`infra/preview/hosted.md`](../../../infra/preview/hosted.md) for exact
provider commands, ingress checks and ID-bound teardown.

## Operator inputs required before provisioning

| Input | Required decision |
| --- | --- |
| Spend cap | Maximum combined Railway/Netlify spend for this run |
| Account | Provider account/workspace to charge and operator allowed to create preview resources |
| Teardown deadline | UTC deadline and operator responsible for ID-bound teardown |
| Test identities | Two disposable verified-email OAuth users and one separate Matrix observer |
| Native sessions | Two already-running Codex 0.157.1 Linux x64 GPT-6-Sol sessions, one per owner, with private homes and installed trusted Khala launcher/hooks |

Do not create or mutate provider resources until the first three operator
inputs are supplied. Keep credentials, rendered configs, descriptors and
rollouts in a private temporary directory outside the checkout.

## Exact resources to create after authorization

1. In Railway project `9f30bc02-e7b5-45c4-95f4-e50b10034696`, create
   `preview-kha134-<unique-suffix>` without duplicating production. Provision
   only new Postgres 16, Synapse 1.161.0, Caddy ingress and Dex 2.43.1
   services. Give Synapse, Postgres and Dex separate persistent volumes as
   specified in the hosted packet. Record every ID.
2. Create a new Netlify site `khala-134-preview-<same-suffix>`; deploy a
   branch draft from the exact Khala commit under test. Do not publish to
   `khala-aiur`. Register the draft callback URL in disposable Dex.
3. Verify HTTPS discovery, OIDC PKCE for both disposable users, Matrix ingress
   restrictions, server/device trust and owner routes. Create one encrypted
   room admitting both users. Establish two owner-specific agent participants,
   bindings and review policies using real pairing; do not seed a binding
   through the test.
4. Run one user systemd connector unit and one already-running native Sol
   session per owner. Each unit's private `connector-control.mjs` config
   pins its exact binding, generation, session, process and cgroup. Fill the
   private 0600 live descriptor with `controls` and `reviewNative` for owner
   one, `reviewPeer` and `reviewPeerNative` for owner two, plus the human
   and observer fields in the linked fixture READMEs. Supply OAuth passwords
   and observer token only through named environment variables.
5. Run `KHALA_E2E_LIVE=1 KHALA_E2E_DISPOSABLE_ENV=<absolute-private-descriptor>
   pnpm test:integration tests/integration/review/four-actor.spec.ts`.
   Record sanitized command result, exact commit/deploy IDs, version,
   release/ACK outcomes, and failure/recovery observations. Do not archive
   canary bodies, tokens, cookies, private rollouts or inbox files.
6. At the approved deadline, use the filled
   `infra/preview/teardown-target.template.json` record and
   `infra/preview/teardown.ts --check`, then its ID-bound `--apply`
   procedure. Confirm production IDs remain visible and revoke preview
   credentials.

The four-actor driver proves selected-only native consumption for this pinned
route if it passes. AE1 crash-after-write uncertainty and other harness/model
versions remain separate acceptance obligations. A failed or skipped run is
not hosted proof.
