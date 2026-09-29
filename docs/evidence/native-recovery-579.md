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
