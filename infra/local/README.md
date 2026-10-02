# Long-lived local external stack

Prerequisites: Node.js and pnpm at the versions in the root `package.json`,
Docker with Compose v2 and a running daemon, Netlify CLI, OpenSSL, and
`mkpasswd` with bcrypt support. Install workspace dependencies with
`pnpm install` before starting.

```sh
pnpm stack:up
pnpm stack:status
pnpm stack:logs            # all services
pnpm stack:logs synapse    # synapse, postgres, dex, netlify, or gateway
pnpm stack:down
```

`up` builds the web app and functions, starts Postgres, Synapse, Dex, Netlify,
and an HTTPS gateway, then exits while the stack keeps running. Repeating
`up` reuses the saved secrets, ports, and database. The gateway prefers
`https://127.0.0.1:8443`; use the origin printed by `stack:status` if that port
was occupied when the stack was created.

Private state, credentials, certificates, and test configuration live in
`.khala-local/`. Detached process logs are in `.khala-local/logs/`; container
logs are available through `stack:logs`. A startup failure leaves started
services running and prints the failing log location and its last 40 lines.
`stack:status` prints the service status and local user credentials as JSON.

Run the existing human browser spec against the running stack:

```sh
pnpm exec playwright install chromium
source .khala-local/e2e.env
pnpm test:integration tests/integration/human/create-share-chat.spec.ts
pnpm stack:status
```

The environment file supplies the descriptor, both test users, observer token,
and local certificate trust. Browser tests leave the stack running. Keep the
state directory and its credentials private.

`pnpm stack:down` stops services and keeps their data. To delete the stack's
volumes, credentials, certificates, and saved ports and start fresh:

```sh
pnpm stack:down --wipe
pnpm stack:up
```
