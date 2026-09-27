# KHA-134 disposable hosted preview

This is a deployment packet, not a deployment record. Provision only after the
operator approves a spend cap, account, and teardown deadline. Keep the filled
`teardown-target.template.json` outside the repository. Never select Railway
`production` or Netlify `khala-aiur`.

## Services and secrets

- `infra/messaging/hosted/` derives from pinned Synapse 1.161.0. Inject the
  rendered config as secret `KHALA_HOMESERVER_CONFIG_B64`; the entrypoint
  decodes it into private ephemeral `/config`, unsets the variable, sets the
  new persistent `/data` volume owner to UID/GID 991, and invokes upstream
  `/start.py run`, which drops Synapse to 991. Set `RAILWAY_RUN_UID=0` for the
  entrypoint. Do not mount `/config` on a volume.
- `infra/messaging/ingress/` derives from pinned Caddy 2.10.2. Give **only**
  Caddy a Matrix public HTTPS domain on port 8080. Set
  `KHALA_SYNAPSE_UPSTREAM` to the new Synapse private DNS name and port 8008.
  Its separate `KHALA_REGISTRATION_INGRESS_TOKEN` permits only exact GET/POST
  `/_synapse/admin/v1/register`, then is stripped. Other admin routes return
  403. Client and health routes proxy; all other routes return 404. Synapse's
  nonce/HMAC secret remains mandatory. No public Synapse or Postgres domain.
- `infra/preview/hosted-dex/` derives from pinned Dex v2.43.1. Render the
  config with `renderHostedDex` (`render-dex.ts`), which requires HTTPS issuer
  and callback and uses `/data/dex.db` for persistent signing and replay state.
  Inject it as secret `KHALA_DEX_CONFIG_B64`, mount a separate persistent
  `/data` volume, and set `RAILWAY_RUN_UID=0`. The entrypoint drops Dex to
  UID/GID 1001. Give Dex its own HTTPS domain on port 5556. SQLite is for this
  disposable single-instance preview only; do not promote it to production.

Base64 is transport encoding, not encryption. Store both encoded configs as
provider secrets; never put them in argv, a build layer, logs, or GitHub.
Railway CLI supports `railway variable set KEY --stdin --service <new-id>
--environment <new-id> --project <khala-id> --skip-deploys`. The Netlify CLI's
`env:set` takes secret values as argv, so use the new site's scoped UI for
Netlify server secrets. Its `MATRIX_REGISTRATION_INGRESS_TOKEN` must equal
Caddy's token, while `MATRIX_REGISTRATION_SHARED_SECRET` is the separate
Synapse HMAC secret. Keep `KHALA_ADMISSION_MODE` unset pending G-ADMISSION.

## Provider sequence after approval

1. In a new temporary local directory, `railway link --project
   9f30bc02-e7b5-45c4-95f4-e50b10034696 --environment production`, then
   `railway environment new preview-kha134-<suffix> --json` **without**
   `--duplicate`. Record the returned ID and relink the temporary directory
   to that exact environment. Never link the Khala checkout.
2. Create new preview services only: digest-pinned Postgres 16 with a data
   volume; Synapse with `/data`; Caddy ingress; and Dex with `/data`. Record
   each service/volume ID. Use Railway private DNS for Postgres and Caddy's
   upstream. Upload each Dockerfile directory with `railway up <path>
   --path-as-root --project <project-id> --environment <preview-id>
   --service <service-id> --detach`. Set secrets through stdin or provider UI.
3. Generate Caddy and Dex HTTPS domains. Render Synapse with the **actual**
   Caddy origin and a new immutable preview `server_name`. Start services and
   verify Synapse UID 991, Dex UID 1001, and stable signing identity through
   one replacement each. From the approved checker vantage, point
   `KHALA_MATRIX_CHECK_ORIGIN` at Caddy HTTPS and set private
   `KHALA_MATRIX_REGISTRATION_INGRESS_TOKEN`. Run
   `node infra/messaging/check.ts --environment preview`; a pass now checks
   anonymous register 403, credentialed nonce 200, other admin denial,
   client readiness, database lookup, and public registration denial.
4. Create a **separate** Netlify site `khala-134-preview-<suffix>` with
   `sites:create --disable-linking --filter @khala/web`. Set site-specific
   public and server variables for the selected `branch-deploy` context. Use
   an explicit site ID and stable draft `--alias`, never `--prod`. Read the
   actual deploy URL, correct `PUBLIC_APP_ORIGIN` and redeploy if necessary,
   then register that URL's `/api/human/auth/callback` in Dex. Verify HTTPS
   discovery/JWKS, CSP, functions, and two-user PKCE login.
5. Fill the secret-free teardown record with the actual new IDs and deadline.
   `node infra/preview/teardown.ts --manifest <record> --check` verifies both
   targets and refuses production IDs. Run the hosted human suite with its
   separate disposable descriptor and private credentials. Retain sanitized
   results, exact commit, resource IDs, versions, and key fingerprints.

At the approved deadline, `--apply` plus
`KHALA_134_TEARDOWN_APPROVED_TARGET=<preview-env-id>:<preview-site-id>` deletes
only those two ID-bound targets and verifies production targets remain visible.
If a provider call fails partway, reconcile recorded IDs manually; never use
name-only wildcard deletion. Revoke preview credentials and remove private
local renders. The hosted proof remains unclaimed until this sequence runs.
