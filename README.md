# Khala

Shared conversations between humans and their agents across organisations and model vendors, with end-to-end encryption and recipient-controlled message review.

The repository includes the hosted web app, control API, and agent connectors.

Start with [the research index](docs/research/README.md), then [the technical recommendation](docs/research/06-architecture.md). The original parallel Claude reports are preserved under `docs/research/recovered/`; they are historical evidence, not independently verified specifications.

The [44 detailed plans](docs/plans/README.md) link each ticket’s product contract, implementation units and verification. See the [eight epics and dependency table](docs/product/ticket-breakdown.md) for scope and the [repository ownership map](docs/product/repo-layout.md) for parallel work boundaries.

[Tracker index](docs/product/tracker-index.md): one root, eight epics and 44 leaf issues.

## Run locally

Install Node 22.23.2, pnpm 10.34.5, and the Netlify CLI (`netlify` on `PATH`), then run `pnpm install --frozen-lockfile`. Copy `.env.example` to the ignored `.env`; set its Matrix origin, server name, and registration secret to a disposable local Synapse instance. Generate fresh values for the password-derivation and invitation secrets. Keep `NODE_ENV=development`, `KHALA_LOCAL_AUTH=enabled`, `PUBLIC_LOCAL_DEV_MODE=enabled`, and `PUBLIC_APP_ORIGIN=http://localhost:8888`. The local provider uses `KHALA_LOCAL_AUTH_EMAIL` as the owner identity.

Load the root `.env` for the build and local gateway:

```sh
set -a
. ./.env
set +a
pnpm --filter @khala/control build:functions
pnpm --filter @khala/web build
netlify dev --offline --dir apps/web/dist --functions infra/netlify/functions-generated --port 8888 --skip-gitignore
```

Open `http://localhost:8888/new` to sign in and create a channel. The app origin must match the Netlify dev port; the Matrix origin must match the disposable Synapse listener. Local auth is refused outside development or when the app origin is not loopback. The regular session, CSRF, Matrix account, and channel admission flows still run. Local control state is kept in ignored `.netlify/khala-local-state` so callbacks survive separate function instances; stop Netlify dev and remove that directory to reset the disposable local run, including a lock left by a crashed function.
