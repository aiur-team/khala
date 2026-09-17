# Synapse/Postgres feasibility experiment

This isolated TypeScript runner tests official OSS services, without a paid account.
It is not production configuration or an encrypted chat implementation.

Requirements: Node 24.18+, Docker Engine with Compose, pnpm 10.34.5; enough memory
for two disposable containers. Image downloads require network access.

```sh
pnpm --dir experiments/backend install --ignore-workspace --frozen-lockfile
pnpm --dir experiments/backend check
pnpm --dir experiments/backend test
# Structured sanitized measurements instead of TAP:
pnpm --dir experiments/backend proof
# Configuration validation only (does not start services):
docker compose -p khala-backend-spike -f experiments/backend/compose.yaml config --quiet
```

If the host's `/tmp` user quota is exhausted, set `TMPDIR` to an existing private
directory on a filesystem with space (the recorded capture used
`TMPDIR=/home/everdred/.cache node experiments/backend/check.ts --proof`).

`test` runs real services, not mocks. Each run creates an unpredictable project
name, refuses existing project resources, generates fresh database and registration
secrets, starts Synapse/Postgres, registers Alice/Bob through the local shared-secret
admin boundary, creates a private room, joins Bob, sends a synthetic plaintext
marker, restarts both containers and checks account IDs, signing-key fingerprint,
readable history and replay. It stops Postgres and requires a database-backed write
to receive a definitive HTTP 5xx rejection, restarts Postgres and requires a fresh
transaction to create a distinct event readable by Bob. A timeout is recorded as
unknown outcome and does not pass the rejection test. Tokens and signing keys never
appear in evidence. Secrets live in a mode-0600 file in a mode-0700 temp directory.
`finally` removes only that run's containers, volumes, networks and secret file.
An abrupt process kill can leave resources; identify its `khala-backend-spike-*`
Compose project and remove only that project. Never globally prune Docker storage.
Do not run `compose up` manually: defaults support parsing, not runtime credentials.

Postgres has no host port and shares an internal network with Synapse. Synapse also
needs a normal bridge network for Docker to publish its randomly allocated
loopback-only client port. There is no federation listener. The experiment container
runs as root to initialize its disposable volume; production needs a reviewed
non-root ownership setup, TLS, ingress restrictions and operational hardening.

`proof(async ({baseUrl, alice, bob}) => { ... })` exported from `check.ts` allows
sibling experiments to exercise disposable accounts before the persistence proof.
The callback must not print token values. Its failure still triggers cleanup.

Images are pinned by immutable digest, including version tags for readability:
Synapse 1.161.0 (upstream AGPL-3.0-or-later or commercial option), Postgres major 16
(PostgreSQL License). See [Synapse source/license](https://github.com/element-hq/synapse),
[official Docker guidance](https://element-hq.github.io/synapse/latest/setup/installation.html),
[database requirements](https://element-hq.github.io/synapse/latest/postgres.html), and
[PostgreSQL license](https://www.postgresql.org/about/licence/). Exact observed
Postgres minor version and host/image details are recorded in the evidence report.

Adoption remains conditional: browser/headless crypto and key recovery (141/142),
connector restart (144), license review, stable production domain, ingress/TLS,
backup and full restore proof, security/upgrade operations, hosted resource sizing
and actual billing must be resolved. Netlify remains the intended TypeScript web
and control host; an always-running connector lives with its owner. Railway is an
acceptable future home for OSS services; this experiment provisions nothing there.
