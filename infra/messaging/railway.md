# Messaging deployment boundary

This package turns the Synapse/Postgres candidate proven by KHA-102 into a
reproducible deployment boundary. It pins the same official images, keeps the
database private, persists the Synapse signing key and media with its `/data`
volume, and rejects public registration. It does not provision Railway or select
a production Matrix identity.

## Inputs and immutable identity

Copy `env.example` into a secret-managed environment and replace every
placeholder. `KHALA_MATRIX_SERVER_NAME` identifies users, rooms and signing
identity. Approve it before the first durable production start; changing a
Railway domain later does not change that identity safely. The Khala web origin
`https://khala.aiur.team` is not a default Matrix server name.

Use a distinct `KHALA_STATE_NAMESPACE`, domain, database, Synapse volume and
secrets for `preview` and `production`. The checker requires the namespace to end
in the selected environment and refuses placeholder domains or secrets. Rendered
`homeserver.yaml` contains a database password: generate it only in a private
directory, never in the repository or a web bundle. The parent directory is
mode 0700; the rendered file is mode 0644 because Docker bind-mounts that file
directly for the official image's non-root user.

## Disposable local preview

Node 22.23 or newer and Docker Compose are required. The repository root does
not own a `tsx` dependency, so these TypeScript files use Node's built-in type
stripping and only Node APIs.

```sh
export KHALA_ENVIRONMENT=preview
export KHALA_STATE_NAMESPACE=khala-preview
export KHALA_MATRIX_SERVER_NAME=matrix.preview.test
export KHALA_MATRIX_PUBLIC_ORIGIN=https://matrix.preview.test
export KHALA_DB_HOST=postgres
export KHALA_DB_PORT=5432
export KHALA_DB_NAME=synapse
export KHALA_DB_USER=synapse
export KHALA_DB_PASSWORD='<secret-manager-value-at-least-24-characters>'
export KHALA_CONFIG_DIR='<private-absolute-directory>'

node infra/messaging/check.ts --environment preview --render-only
docker compose -p "$KHALA_STATE_NAMESPACE" -f infra/messaging/compose.yaml config --quiet
docker compose -p "$KHALA_STATE_NAMESPACE" -f infra/messaging/compose.yaml up -d --wait
```

The one-shot `synapse-data-init` service changes only the fresh `/data` volume
owner to the official image's UID/GID 991, then exits. The long-running Synapse
service still runs as that non-root user.

Discover the random loopback port with `docker compose port synapse 8008`, then
set `KHALA_MATRIX_CHECK_ORIGIN` to that `http://127.0.0.1:<port>` value and
`KHALA_ALLOW_INSECURE_LOOPBACK=true`. Run:

```sh
node infra/messaging/check.ts --environment preview
```

The structured result contains no token or database password. A pass requires a
client versions response, a database-backed lookup for an unpredictable synthetic
local user to return not-found, anonymous registration rejection, and
unauthenticated admin rejection. Synapse's `/health` endpoint is only process
liveness; it is not database-readiness evidence. A database-backed probe returning
5xx fails with the sanitized reason `database-unavailable`.

To check replacement, record the signing-key fingerprint inside the container,
force-recreate only `synapse`, wait for health, run the checker again, and compare
the fingerprint. KHA-102 already proves retained accounts/history and fresh writes
after database recovery on these exact image digests. The browser/headless crypto
evidence separately proves encrypted history across client restart; this package
does not repeat either feasibility experiment.

Remove only this preview project when finished:

```sh
docker compose -p "$KHALA_STATE_NAMESPACE" -f infra/messaging/compose.yaml down --volumes
```

### Local verification record

On 2026-09-17, the package passed with Node 24.18.0, Docker Engine 29.6.2
and Docker Compose 5.3.1 on Linux. The sanitized observations were:

- Compose configuration parsed without materializing its secret-bearing output.
- A fresh Postgres/Synapse preview became healthy; the Synapse main process ran
  as UID 991 after the one-shot volume initialization.
- Client versions succeeded, anonymous registration returned 403, an
  unauthenticated user-list admin request returned 401, and the synthetic
  database lookup returned not-found.
- Recreating only the Synapse service retained the signing-key fingerprint and
  the boundary checks still passed.
- Stopping Postgres produced `database-unavailable`; restarting it restored a
  passing boundary check.
- The scoped containers, networks and volumes were removed after the proof.

This record demonstrates local packaging and replacement behavior. It reuses the
KHA-102 account/history persistence proof and the KHA-141/KHA-142 encrypted
client-history proofs; it does not claim hosted Railway, backup/restore, capacity
or production identity evidence.

## Railway promotion contract

Keep Synapse and Postgres as separate services in one Railway environment.
Railway private networking replaces the Compose network: point
`KHALA_DB_HOST` at the Postgres private service hostname and do not generate a
public Postgres domain. Expose Synapse port 8008 through Railway HTTPS, preserve
the incoming `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` headers, and route
only the intended Matrix client paths. The client listener also implements
authenticated Synapse admin routes, so ingress must deny public
`/_synapse/admin` paths in addition to Synapse requiring an admin access token.
The template's client-only listener omits inbound federation endpoints, and its
empty federation domain whitelist denies outbound federation requests.

Attach a persistent volume at `/data` to Synapse. Postgres needs its own durable
database storage (or the selected Railway Postgres service). Deliver the rendered
configuration to Synapse as a secret-managed runtime file mounted at
`/config/homeserver.yaml`; provider-specific file injection must be proven before
promotion. Railway mounts a new volume as root, so the approved start command must
set `/data` ownership to UID/GID 991 before invoking `/start.py run`; the entrypoint
then drops the long-running process to that identity. A Railway volume surviving replacement is persistence evidence, not a
backup or restore result. KHA-109 owns backup sets and restore rehearsal.

Before production mutation, record approval for the Matrix `server_name`, public
Matrix domain, DNS/TLS, hosting account and budget, license choice, secret/file
delivery, ingress rules, resource sizing, monitoring and upgrade policy. None of
those provider operations were performed by this local-preview package.

## Pinned services

- Synapse 1.161.0: `ghcr.io/element-hq/synapse:v1.161.0@sha256:7155ddc4835e5b8afa4e1598d92aa16ff1d03109f7d1cff61d493237d1210b1d`
- PostgreSQL 16: `postgres:16@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94`

The configuration follows the upstream requirements for a UTF-8 database with
`C` locale, a reverse proxy in front of the container listener, and persistent
Synapse identity data. Railway's Compose and volume documentation supplies the
service/private-network and mount-path mapping; validate those provider behaviors
again when the gated hosted deployment is approved.
