# Backend backup, restore and upgrade proof

Proves that Khala's backend (Synapse + PostgreSQL, packaged by `infra/messaging/`;
see `infra/messaging/railway.md`) can be backed up, restored into an isolated
disposable environment, and upgraded with a verified recovery route. It does
not select production retention or recovery objectives — those remain an
explicit operator decision (see "Retention, RPO and RTO" below) — and it does
not repeat the encrypted-history or Railway-hosting proofs already recorded
elsewhere (see "Related evidence").

## Ownership

`infra/operations/` and this page are owned per `.github/CODEOWNERS`
(`@its-everdred`). A second operator reproducing the rehearsal below needs only
this page, `infra/operations/*.ts` and `infra/messaging/compose.yaml`; no
additional undocumented setup.

## What each script does

All three scripts are plain Node with built-in TypeScript type stripping (no
`tsx`, matching `infra/messaging/`'s existing convention — the repository's
`pnpm typecheck`/`pnpm test` workspace scope covers `apps/*` and `packages/*`
only, so `infra/operations/` is verified the same way `infra/messaging/` is:
`node --test infra/operations/*.test.ts`, `tsc --noEmit` with
`--allowImportingTsExtensions`, and `eslint infra/operations/`, plus the manual
rehearsal below). Every mutating step is injectable as a "port" function
(`BackupPorts`, `RestorePorts`, `UpgradeCheckPorts`); the shipped
`dockerComposePorts` implementations operate the disposable
`infra/messaging/compose.yaml` stack. Errors are a stable `OperationsError`
code (never a raw stack trace) so failures are safe to alert on.

- **`backup.ts`** — dumps the database (`pg_dump --format=custom`), archives
  the signing key and media from Synapse's `/data`, copies the rendered
  config, hashes the database/media artifacts, and writes
  `backup-manifest.json` (validated against `manifest.schema.json`) only after
  every artifact step has succeeded. A partial failure never leaves a manifest
  behind — there is nothing for a stale-backup alert to false-negative on.
- **`restore.ts`** — rehearses a restore into an isolated, disposable target.
  Refuses a wrong or non-allowlisted target, a production target, source-volume
  reuse, or a corrupt/incomplete artifact set *before* any mutation. Only then
  does it deny and verify egress isolation, restore database/media, and boot
  the signing identity — never before isolation is confirmed. It finishes by
  querying the restored database directly for expected synthetic event IDs and
  recording measured recovery time and the data-loss window (time between the
  backup's `created_at` and the restore start).
- **`upgrade-check.ts`** — tests a target Synapse image's migration against a
  disposable copy of the database, health-checks the result, and records
  whether backward migration is supported. A same-digest target is reported as
  a no-op, never a false "rollback tested" claim. When backward migration is
  not supported (the default assumption, per Synapse's own operator docs), the
  recorded safe sequence is restoring the pre-upgrade backup, not downgrading
  the image in place (R3).

## Reproducing the restore rehearsal

This is the exact sequence a second operator runs; it does not require
Railway access. All values below are disposable/synthetic.

```sh
# 1. Bring up a source stack (see infra/messaging/railway.md for the full
#    disposable-preview walkthrough) and populate it with real history via
#    the ordinary Matrix client API — never by hand-editing rows in `events`,
#    which breaks Synapse's own internal invariants.

# 2. Back it up:
export KHALA_ENVIRONMENT=preview
export KHALA_STATE_NAMESPACE=khala-source-preview
export KHALA_DB_HOST=postgres KHALA_DB_PORT=5432 KHALA_DB_NAME=synapse KHALA_DB_USER=synapse
export KHALA_DB_PASSWORD='<the running stack'"'"'s password>'
export KHALA_CONFIG_DIR=/private/khala-source-config
export KHALA_BACKUP_OUTPUT_DIR=/private/khala-backup-set       # non-secret: manifest + hashed database/media
export KHALA_BACKUP_SECRETS_DIR=/private/khala-backup-secrets  # secret: signing key + config, reference-only in the manifest
node infra/operations/backup.ts --environment preview

# 3. Validate the manifest structure alone (no target/mutation required):
node infra/operations/restore.ts --validate-only --manifest "$KHALA_BACKUP_OUTPUT_DIR/backup-manifest.json" --environment preview

# 4. Execute the full restore rehearsal. Full execution takes an explicit
#    target/expectations pair and is not exposed as a bare CLI flag (a
#    real target and its allowlist must come from the runbook, not a typo-able
#    flag) — call runRestore directly:
export KHALA_STATE_NAMESPACE=khala-rehearsal-1        # the fresh disposable target's own namespace
export KHALA_DB_PASSWORD='<same value as step 2>'      # the restored config's embedded DB credential must match what the target's own postgres is provisioned with
export KHALA_CONFIG_DIR=/private/khala-rehearsal-config # 0700, empty; receives the restored homeserver.yaml
node --input-type=module -e '
import { runRestore, dockerComposePorts } from "/abs/path/to/infra/operations/restore.ts";
import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(process.env.KHALA_BACKUP_OUTPUT_DIR + "/backup-manifest.json", "utf8"));
const proof = await runRestore({
  manifest,
  sourceStateNamespace: "khala-source-preview",
  artifactDir: process.env.KHALA_BACKUP_OUTPUT_DIR,
  secretsDir: process.env.KHALA_BACKUP_SECRETS_DIR,
  target: { stateNamespace: "khala-rehearsal-1", environment: "preview", usesFreshVolumes: true },
  allowedTargetIds: ["khala-rehearsal-1"],
  expectations: { eventIds: ["<expected event id 1>", "<expected event id 2>"], syntheticUserId: "@<synthetic user>:<source server name>" },
}, dockerComposePorts);
console.log(JSON.stringify(proof, null, 2));
' 2>&1

# 5. Tear down both stacks and remove the backup artifacts once satisfied:
docker compose -p khala-rehearsal-1 -f infra/messaging/compose.yaml -f infra/operations/rehearsal-isolation.override.yaml down --volumes
docker compose -p khala-source-preview -f infra/messaging/compose.yaml down --volumes
rm -rf "$KHALA_BACKUP_OUTPUT_DIR" "$KHALA_BACKUP_SECRETS_DIR"
```

`infra/operations/rehearsal-isolation.override.yaml` composes on top of
`infra/messaging/compose.yaml` to mark the otherwise-public `client-edge`
network `internal: true` for the rehearsal project only, so the target has no
route to the internet or to production discovery/DNS by construction. Because
Docker also disables host port forwarding on an internal network, the
restored Synapse is unreachable from the host too — verify it only via
`docker compose exec`/`run` from inside the isolated project.

Never restore into `khala-preview` or `khala-production` directly (`restore.ts`
refuses any target whose `environment` is not `preview`, and refuses
`stateNamespace === sourceStateNamespace` as source-volume reuse). A real
incident restore into a live namespace remains a deliberate, manually
supervised operation outside this tool's allowlist-and-mutate path.

### Local verification record

On 2026-09-17, this rehearsal ran end to end on Node 24.18.0, Docker Engine
29.6.2, Docker Compose 5.3.1, Linux, 16 CPUs / 31 GiB RAM (per the
"Reproducing the restore rehearsal" steps above, against real Matrix protocol
history — an admin-created synthetic user, a room and two real messages sent
through the ordinary client API, not hand-inserted rows):

- `node --test infra/operations/*.test.ts`: 18/18 passing (manifest
  validation, target/environment/volume-reuse refusal, corrupt-artifact
  refusal, egress-isolation-failure abort ordering, successful-restore proof
  shape, and upgrade no-op/rollback-naming/safe-sequence behavior).
- `tsc --noEmit --strict ... --allowImportingTsExtensions` and
  `eslint infra/operations/`: clean.
- A real backup produced a validated manifest (database dump ~290 KB, media
  archive, signing-key and config artifacts referenced but not hashed) with
  no credential or key material present in the manifest or its content
  (checked by pattern, per the `restore.test.ts` assertion of the same).
- A real restore into a disposable, freshly named target (`khala-rehearsal-1`,
  distinct from the `khala-source-preview` it was backed up from) refused to
  run before the target allowlist, environment, and fresh-volume checks
  passed, denied egress before any container booted, and only then restored
  the database, media and signing identity.
- The restored server matched both real event IDs from the source room,
  accepted the original synthetic user's password (same signing identity, same
  account), and the restored `server.signing.key` was byte-identical to the
  source's (`sha256` match).
- Measured recovery time (restore start to verified) was ~14 seconds; the
  data-loss window (last backup to restore start) was ~18 seconds — both are
  artifacts of this rehearsal's tiny synthetic dataset and local disk, not a
  production RTO/RPO estimate (see below).
- An isolated egress probe from inside the target correctly reported
  `Network is unreachable`; the restored Synapse was unreachable via any
  host-published port (internal network disables host port forwarding
  entirely, not just outbound).
- Every container, volume and network created by the rehearsal was removed
  afterward; no `khala-*`-prefixed volume was left behind.

This record demonstrates the backup/restore/isolation mechanics against the
local disposable stack. It does not repeat the Railway-hosted proof (not yet
provisioned; see `infra/messaging/railway.md`'s "Railway promotion contract")
or the browser/headless E2EE proof (KHA-141/KHA-142). A hosted rehearsal must
re-run this same sequence against the real Railway volumes before this
evidence can be treated as covering production.

## Resource baseline (local disposable rehearsal)

Measured on the host that ran the rehearsal above: 16 CPUs, 31 GiB RAM (~23
GiB available at the time), 1.9 TB root filesystem with 1.5 TB free. The
rehearsal's own footprint was small (a ~290 KB database dump, a two-message
media/room fixture, two short-lived Postgres+Synapse container pairs). This is
not a production capacity plan — Railway resource sizing is listed as an open
approval item in `infra/messaging/railway.md` and remains an operator decision.

## Retention, RPO and RTO — operator decision, not an invented SLA

This package does not schedule recurring backups, define a retention window,
or claim a production recovery time/point objective. Those numbers must come
from an explicit operator decision before this runs against `khala-production`
or `khala-preview`. Until that decision is recorded, only the disposable
rehearsal above is authorized (per the ticket's "Backup retention and recovery
objectives require operator decision before production operation; disposable
rehearsal remains executable").

## Alerting on stale or failed backups

No scheduler exists yet for recurring production backups (out of scope for
this ticket). Whatever job runner is chosen to run `backup.ts` on a schedule
should alert on both of the following, because the script's own failure mode
makes them the correct signals:

- **Failed job**: `backup.ts` exits non-zero with a JSON `{ ok: false, reason:
  "<OperationsError code>" }` on stderr and — because the manifest is only
  written after every artifact step succeeds, via write-then-atomic-rename —
  never leaves behind a manifest that looks complete but isn't.
- **Stale backup**: alert if the newest `backup-manifest.json`'s `created_at`
  exceeds the (operator-decided) backup interval plus a grace period. Do not
  infer freshness from the job scheduler's own "last run" state alone; read
  the manifest's `created_at`, since a job that "ran" but failed before
  writing a manifest is exactly the failure this is meant to catch.

## Account-specific caveats

- Railway's Compose/volume tooling snapshots within one project/environment;
  it is not a cross-environment or cross-account disaster-recovery mechanism
  (`infra/messaging/railway.md`). This package's logical `pg_dump` plus
  protected identity/config/media artifacts is the actual cross-environment
  recovery set — Railway snapshots remain supplementary.
- The Synapse signing key (`server.signing.key`) is the server's cryptographic
  identity. Losing it is not recoverable by restoring the database alone —
  federation and any signature-dependent behavior would need a new identity —
  which is why `restore.ts` treats a missing signing-key artifact as a hard
  failure even when the database and media restore cleanly (AE2).
- `KHALA_MATRIX_SERVER_NAME` is immutable identity, not a hosting detail: a
  restored server must reuse the exact backed-up value, never a value derived
  from wherever it happens to be rehearsed or hosted.

## Related evidence

- Deployment packaging and the disposable local-preview walkthrough:
  `infra/messaging/railway.md`.
- Account/history persistence across database recovery on these pinned image
  digests: KHA-102.
- Encrypted history surviving a real browser/headless client restart:
  KHA-141/KHA-142 (this package does not repeat either).
