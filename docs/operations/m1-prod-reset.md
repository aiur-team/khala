# M1 production reset (KM-152)

Run 2026-10-02 by the Khala Claude Executor.

## Operator authority

The operator's go, quoted (2026-10-02 ~15:00 UTC): "wipe production, none of that data is real, just tests. no ssh needed".
The operator waived the database and `/data` backups. The planned Railway `pg_dump` and `/data` tar were
never taken: they need `railway ssh`, and that needs a passphrase-protected key.

## Discovery

| Item | Value |
|---|---|
| Netlify site | `e95155c4-1070-46f8-95eb-4ca86df16030` (khala-aiur) |
| Rollback deploy (published before this run) | `6abea4bdf8be2f19d00fe2f8` |
| Required env keys (schema at `2db1eb37`) vs production | none missing |
| `PUBLIC_APP_ORIGIN` / `PUBLIC_HOMESERVER_ORIGIN` | `https://khala.aiur.team` / `https://matrix.khala.aiur.team` |
| OIDC issuer | `https://accounts.google.com` |
| Railway project | `9f30bc02-e7b5-45c4-95f4-e50b10034696`, services `synapse` and `Postgres` |
| Synapse database | `synapse` on `postgres.railway.internal`, user `synapse` (from `KHALA_HOMESERVER_YAML_B64`; the ticket's `KHALA_DB_*` variable names do not exist) |
| Homeserver checks | `/_matrix/client/versions` lists 20 versions; `POST /_matrix/media/v3/upload` → 401 |

## Backup

Only the Netlify Blobs control state was backed up (SDK, 32-way): `khala-production-records` 32,997 keys
(130 MB) and `khala-production-operations` 37,537 keys (163 MB), with 0 failures. It lives at
`~/khala-backups/prod-20261002T0915Z/` (mode 0700) and is not committed.

## Reset

- **Control state:** `CONTROL_STATE_NAMESPACE` rotated from `khala-production` to `khala-production-m1`. The old stores remain.
- **Synapse:** not wiped. Owner ids are random and live in the control namespace
  (`resolveOwner`), and Matrix localparts derive from owner ids (`ownerMatrixLocalpart`). Agent ids derive
  from each join. After the rotation every human and agent is therefore a **new** Matrix user, which
  satisfies the first-device rule. The old Matrix users and rooms are orphaned test data.

## Deploy

- Built locally from `main` `079805f6` (Node 24.18.0; `netlify.toml` pins 22.23.2 for remote builds only)
  and deployed with `netlify deploy --prod --no-build --dir apps/web/dist --functions infra/netlify/functions-generated`.
- First deploy `6abfc74eacb1d86baa24b4f0`: the web bundle lacked `PUBLIC_*` values, so the app showed "Khala is
  unavailable … set PUBLIC_APP_ORIGIN and PUBLIC_HOMESERVER_ORIGIN". **Local builds must export the
  production `PUBLIC_*` values.** Netlify's remote build injects them, a local build does not.
- Fixed deploy `6abfcc70f9599b91b658a6ac`, title "main 079805f6; M1 reset (public env)".
- **Verification:**
  - (a) The published deploy id equals the `deploy.json` id.
  - (b) The title starts with `main 079805f6`.
  - (c) `/channels/verify` equals the local `apps/web/dist/index.html` apart from the HUD `<script>` that Netlify injects.
  - CSP `connect-src 'self' https://matrix.khala.aiur.team`.
  - `POST /api/agent/join {}` → 400. `/llms.txt` → 200.

## Rollback

1. `netlify api restoreSiteDeploy --data '{"site_id":"e95155c4-1070-46f8-95eb-4ca86df16030","deploy_id":"6abea4bdf8be2f19d00fe2f8"}'`.
2. `netlify env:set CONTROL_STATE_NAMESPACE khala-production --context production` (the old stores are untouched).
