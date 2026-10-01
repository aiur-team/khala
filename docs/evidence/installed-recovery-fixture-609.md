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

The root `pnpm test` gate invokes this command, including in standard CI after
Playwright Chromium installation. Requires Node 22.23.2 or newer, npm with its
standard offline package installation support, OpenSSL 3, and a Chromium supported
by the connector (the current bundle's browser contract). When Playwright Chromium
is installed on Linux, the fixture links that real browser directory into the stock CLI's
supported runtime location; otherwise a supported system browser is required.
Packaging uses the repository's bundle script
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
  POST to `/api/agent/bootstrap/redeem` returning a matching binding and DPoP
  capability tuple is dropped. The obsolete `/api/agent/channel-access/redeem`
  endpoint, parsed `kind: admitted` objects and mismatched tuples do not consume it. A child without the private CA
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

## Real connector protocol regression

The production `createHttpChannelAccessRedeem` implementation in
`packages/connector/src/bootstrap/channel-access-http.ts` sends grants to
`/api/agent/bootstrap/redeem` through `createHttpAdmission`. The wire response
contains `binding` and `adapter_capability`; `parseChannelAccessAdmission` turns
that wire body into the connector's `kind: admitted` result.

The original bridge instead watched `/api/agent/channel-access/redeem` and a
wire-level `kind: admitted`. A new real connector HTTP client child, with no
injected fetch, first failed: it returned `admitted` instead of the expected
`outcome_unknown`, proving that the original bridge did not drop its response.
After correcting endpoint and wire tuple detection, it returns `outcome_unknown`.
A second connector process uses the same disposable proof key, performs a
grant-free resume without a binding ID, and parses the returned wire tuple as
`admitted`. The receipt is scoped `connector_protocol_only` and reports two
processes, one redeem request, one resume request, one proof key and one drop.

The server handler in this regression remains a stand-in. There is no hosted
approval, persistent binding allocation, grant issuance, Matrix login, installed
CLI activation journal or native read/send in this check. It verifies that the
fixture can now drop the real client's redemption protocol, not that hosted
restart recovery is accepted. Full composition remains the next integration step.

The first-slice transport and installed-client preflight tests ran independently.
The subsequent integration below joins them through real hosted adapters.

## Installed hosted access and lost response

The next bounded fixture test runs with the other disposable Synapse checks:

```sh
pnpm test:recovery-synapse
```

`tests/integration/recovery/installed-hosted-recovery.test.mjs` packages the stock CLI,
installs its tarball offline, and runs four separate `mcp-serve` processes over
one private state directory. A fixture browser command handles the owner form
and loopback discovery callback; its pinned Claude version output is only a
controlled local label and does not prove a provider session. The private-CA
HTTPS bridge also forwards Matrix requests to disposable Synapse/Postgres.
The production hosted route composition and file-backed control store perform
proof-key approval, discovery consent, access request, owner approval, exchange,
bootstrap redemption and grant-free resume.

One run observed one owner-visible request, one durable channel-access grant,
one durable binding, one requested-device Matrix login and one dropped admitted
redeem response. The first post-approval client process had no local binding
marker after the drop. A new process using only the same operation ID and state
saved the original binding and Matrix session in its local admission file, with
no second grant or requested-device login. The receipt contains only typed
counts. The generated proof key, owner session, grant, Matrix credentials,
invite link and message data never enter the receipt.

This proves installed-client grant-free admission recovery. It does not yet
prove a ready native binding, encrypted read/send, all wrong-tuple and closed
operation refusals, or the required recovery mutation red-before-green check.
Those remain part of #609. Production exact-session acceptance remains with
#579 and #592 and cannot be inferred from this disposable fixture.
