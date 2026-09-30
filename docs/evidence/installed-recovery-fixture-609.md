# Installed recovery fixture foundations

This slice supplies isolated HTTPS response-loss transport and a stock packaged CLI
process runner. **It does not prove lost-response binding recovery, Matrix login
reuse, native agent read/send, or production acceptance.** Issues #609 and #579
remain open. No application behavior changes here.

## Bounded command

From the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm test:recovery-fixture
```

Requires Node 22.23.2 or newer, npm with its standard offline package installation
support, OpenSSL 3, and an installed Chromium supported by the connector (the
current bundle's browser contract). Packaging uses the repository's bundle script
and `npm pack --ignore-scripts`, then installs that tarball with scripts disabled
and offline network resolution. No production settings, tokens, cookies, invites,
or inherited credential environment are copied into the client.

Each test has a timeout; child processes have independent kill deadlines. The
HTTPS listener binds only `127.0.0.1`, uses a fresh one-day private CA and server
certificate, and rejects mismatched Host/absolute-form request targets. Only the
child environment trusts that CA; no system trust store or TLS validation setting
is changed. Private key files are owner-only. Temporary package, CA and client
state directories are removed after completed tests.

## What the tests establish

- A child using the fixture CA reaches a real HTTPS listener. The adapter callback
  returns an admitted redemption before the listener destroys the socket without
  returning headers. A second **independent Node HTTP client process**, not Khala,
  reaches the resume path. This test's adapter is an in-memory transport stand-in;
  it does not perform a durable hosted redemption.
- Refusals and unrelated paths do not consume the drop. Exactly the first successful
  admitted POST to the redeem path is dropped. A child without the private CA
  cannot reach the adapter. Receipts contain only counts and a transport-only scope.
- Two real installed `khala mcp-serve` child processes use the same disposable
  Claude session label and workdir. Their fresh connector creates one actual
  SQLite store, and the second process reopens the same inode. Both status calls
  return typed `unavailable` because no discovery credential/admission exists.
  No redemption is dropped in this preflight. A supplied Claude session label
  alone is not evidence of an actual native agent's identity or authorization.

The response-drop tests first failed with `admitted` instead of `response_lost`
when the HTTPS bridge returned the adapter response normally. After adding the
socket drop they passed. This is red-before-green evidence for the **transport
mechanism only**, not a pre-fix recovery regression in application code.

## Remaining integration

1. Compose real hosted authority/discovery, exact-session approval, access
   exchange/redeem/resume, owner mailbox/trust and send-authorization adapters
   into `startRecoveryTransport({ handle })`. The handler must await a durable
   server commit before returning an admitted response. Add persistent binding,
   grant and real Matrix login counters; adapter response counts are not substitutes.
2. Start disposable Synapse/Postgres with the existing
   `tests/integration/fixtures/closure-synapse.ts` helper and hard resource limits.
   Keep fixture authorities private and isolated from production.
3. Establish an approved proof key, private discovery credential and real native
   session through the fixture control endpoint. Use `installRecoveryClient` with
   the generated CA/origin and exact session/workdir; do not inject CLI collaborators.
4. Record only a keyed pre-redeem journal, commit the server redemption, drop its
   response, then call the installed client again from a new process using its
   existing state without a binding ID. Assert original binding, one grant and one
   Matrix login, then actual fixture read/send and owner-visible reply.
5. Exercise wrong proof/device/generation, denied/revoked/expired and ambiguous
   operation typed refusals against the composed service. Record only typed
   outcomes and counts. Keep production acceptance separately open.

Transport and installed-client tests currently run independently. Joining them
without the real hosted adapters would produce another simulated recovery claim.
