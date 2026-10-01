# Installed recovery fixture foundations

The first slice supplied isolated HTTPS response-loss transport and a stock
packaged CLI process runner. Later sections record installed recovery and native
read/send in the disposable fixture. **None of these runs proves production
acceptance.** Issues #609 and #579 remain open. No application behavior changes
are made here.

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

## Integration status

The later installed-hosted test below composes real hosted routes and disposable
Synapse/Postgres, exercises dropped redemption and restart, and verifies encrypted
native read/send through the packaged CLI. Remaining refusal and route coverage is
listed at the end of this document.

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

Run the installed proof alone with one test worker:

```sh
pnpm test:installed-recovery
```

The CI `pnpm test:recovery-synapse` command also uses one worker for all disposable
Synapse checks. Synapse and Postgres retain the fixture's CPU, memory and PID limits.

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

The continued fixture now creates an encrypted room, starts a real owner Matrix SDK
device in a separate persistent browser profile and waits for its device key to
appear in Synapse. The owner registers that exact device through the protected
proof route. The first installed client is killed immediately after the proxy
drops the committed redeem response; its local binding is still absent. The
restarted installed MCP process remains alive through native readiness, owner
preview, one exact release, `khala_read` and `khala_send`. The owner SDK decrypts
the native reply. The typed receipt records one grant, one binding, one requested
device Matrix login, one drop, one pending owner item, and accepted read/send.
Wrong owner fingerprint, device and binding generation are refused before the
valid owner proof is registered. The installed Claude tool schema rejects a
caller-supplied binding ID with JSON-RPC `-32602`; this is argument validation,
not a downstream binding authorization proof. A changed replay of one owner
mailbox operation returns 409. A connected-session check immediately before
the room closing marker makes the subsequent native send refusal attributable
to closing rather than a prior disconnect. The HTTPS Matrix proxy counts one
encrypted agent send before closing and no additional send afterward; the
installed tool returns `refused/not_connected` for that closed-room attempt.

The fixture first failed with `repair_required` when Chromium lacked its private
CA trust pin. After that, it failed with `owner_device_empty` because the owner
SDK device and protected proof were absent. The final test observes that guard
and a `not_connected` read on the live restarted process before owner proof
registration; the same process later reports a connected session route and
passes read/send. The installed fixture selects a Claude session from
`KHALA_MCP_HARNESS=claude` and `CLAUDE_CODE_SESSION_ID`. It does not exercise
Codex's `_meta.threadId` selector. A one-shot post-restart call had hidden
native readiness because it closed the MCP process before subscription settled.
Each failure was observed before the corresponding fixture change and the bounded
installed test passed afterward. A deliberate mutation making the connector's
resume path unavailable failed the installed test at the required response-drop
boundary: the first post-approval process never reached committed redemption.
After restoring that production code, the exact one-worker installed command
passed with four CLI processes, one grant, one binding, one requested-device
Matrix login and one dropped response. The recovered binding tuple and Matrix
session matched the first committed response. This mutation checks that the
installed test depends on the real resume path; it does not simulate a second
redeem after the response drop.

Exact revoked and expired operation checks and the Codex route comparison remain
for #609. An earlier clock-advanced native send refused with `not_connected`;
that probe was removed because it did not prove an expired operation. The fixture uses no
production secrets and makes no production acceptance claim; real exact-session
acceptance remains with #579 and #592.
