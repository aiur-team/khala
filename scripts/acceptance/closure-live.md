# Local channel-closure component run

Run from the repository root with Node 22, Docker Compose, Chromium, OpenSSL, and installed workspace dependencies:

```sh
mkdir -p "$HOME/.cache/khala-closure-tmp"
TMPDIR="$HOME/.cache/khala-closure-tmp" pnpm exec tsx --conditions=khala-source scripts/acceptance/closure-live.ts
```

The runner creates a unique disposable Synapse 1.161.0/Postgres 16 Docker project, a private SQLite control-store CAS fixture, two connector storage directories, and two Chromium profiles. It removes the Docker project and volumes, config, profiles, and SQLite data in `finally`. A failed assertion produces a sanitized error code; no Matrix tokens, passwords, ciphertext, or room identifiers are printed. Check `docker ps --format '{{.Names}}'` for `khala-closure-*` after a run if interrupted by a signal.

The run exercises production closure handlers/service, owner-room index, protected mailbox routes, connector mailbox client and local closure fence, Matrix closure transport against Synapse, production browser cleanup HTTP decoder and consumer, and the Matrix SDK's `forget(roomId, true)` in both browser devices. It checks wrong owner, wrong room, stale revision and forged-generation refusals; a durable marker that blocks new binding activation; a partial result and retained owner membership after the first Stop receipt; complete and Matrix leave only after the second; blocked owner commands and both agent polls afterward; revoked connector ledgers after restart; durable cleanup-request retrieval; and local room removal by an online browser and a browser that restarts after closure. A retry keeps the operation ID. The second connector is deliberately unpolled during the partial step, representing an unavailable Stop receipt, but this run does not simulate a network partition of an installed connector process.

The ordinary `owner_closure` Matrix localpart probe uses the same shared-secret registration endpoint as production. Synapse accepts its unescaped mixed-case localpart but returns the lowercase user ID on registration and password login. The escaped candidate `khala_b3du=z=x=jf=y2xvc3=vy=z=q` returns exactly that ID on both calls. Until the centralized production mapper repair is integrated, the closure flow uses a separate valid lowercase owner ID; do not generalize that flow to ordinary owners. Re-run with `owner_closure` after the repair lands.

This is a bounded local component proof, not hosted acceptance. Owner authentication and capability issuance are injected fixture authorities (the latter still signs and verifies real DPoP); the disk CAS is a single-process stand-in for Netlify Blobs; connector mailbox requests dispatch in process to the production route; the fixture browser imports the production cleanup consumer/API but not the full application entry point. It does not prove Dex/OIDC, Netlify Blobs under distributed concurrency, a deployed browser/connector process, native model intake, remote erasure, or every offline device's completed cleanup. The durable request is what can reach a future browser session; actual local cleanup is observed only on the two test devices.
