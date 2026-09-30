# Native lost-response recovery evidence (#579)

## Current evidence

The server resume-by-operation change was merged in PR #567 at
`6bb5dda61e49e6b889cc92bf2333c494ca75e72f`. The installed Claude
read/send work (#571) is closed. No deployed SHA has been independently
verified for this receipt.

Controlled source-level checks on the ticket branch:

- `packages/agent-cli/src/composition/hosted-production.test.ts` drops the
  response after the simulated server commits one redemption. Before a fresh
  client instance opens, the journal is `keyed` with no binding ID and no
  retained Matrix session. The new instance recovers by operation ID and
  observes the same binding and Matrix session, one grant and one simulated
  Matrix login.
- `packages/connector/src/bootstrap/channel-access-http.test.ts` checks the
  connector's typed, fail-closed results for wrong proof, device, generation,
  closed/revoked, expired, and unknown or ambiguous operation responses.
- `apps/control/src/composition/agent/channel-access-exchange.test.ts` checks
  the server's exact resume guards and no additional grant or admission.

On 2026-09-29, Node 22.23.2 completed these focused Vitest files with 4,
14, and 16 passing tests respectively. TypeScript checks passed for the CLI
and connector packages; ESLint passed on the changed test files; the CLI
bundle built successfully. These checks ran from the source workspace, not
from an installed package or a deployed endpoint.

These are simulated transport and composition checks. They do not establish
an installed CLI process restart, a real Matrix login count, native read/send,
or a deployed exact-session run.

## Packaged CLI preflight blocker (2026-09-29)

The workspace build at `65060d5a3a311474b5f98d753b5820736fcd252f` was
packed and installed into a private temporary prefix. The tarball SHA-256 was
`03233ea5407e5cbfb0b910589642b0618d7828f60d984999966df7847906564a`.
A fresh installed `khala mcp-serve` process received one
`khala_channel_access_status` call for a disposable operation label. Its first
structured result was `{"ok":false,"v":1,"error":"unavailable","next":"reuse_operation_id"}`;
the private state directory remained empty. No hosted request or redemption
occurred.

The process ran as UID 1000, while the sandbox presents `/` and `/home` as UID
65534. The connector's `openConnectorStorage` ancestor ownership check rejects
this filesystem view with `unsafe_path`, including for a unique `/tmp` store.
This is a controlled installed-client **blocker receipt**, not a lost-response
recovery receipt. The storage guard must remain intact; the full run needs a
filesystem view with valid ancestor ownership.

The same tarball was then installed in a disposable Playwright container with
container-owned `/state` and networking disabled. A fresh Claude MCP entry
returned the same typed `unavailable` status for the disposable operation,
but created `ledger.sqlite` and `trust.sqlite` under its exact session state
directory. This confirms the storage guard accepts the container filesystem.
No discovery credential was available in that isolated preflight, and no
redeem request was sent. The container can host a later controlled fixture;
its status result is not evidence of a recovery failure.

The separate hosted native same-operation stage-two `unavailable` after a
successful proof-key approval belongs to #592. It must be resolved before a
production read/send receipt can be claimed here.

## Remaining acceptance

1. Run a controlled installed CLI/native session with only the pre-redeem
   journal durable. Drop the HTTP response after the server commits redemption,
   restart the client without a binding ID, and verify the original binding,
   one grant, one Matrix login, then read and send.
2. Exercise the failure-closed matrix against that controlled session and
   retain only typed, redacted receipts.
3. After #585/#586 owner consent is deployed, coordinate an owner-approved
   exact-session production read/send with the Executor. Record the deployed
   SHA and redacted owner-visible receipt. Keep invite capabilities, tokens,
   cookies, and message keys out of public artifacts.
