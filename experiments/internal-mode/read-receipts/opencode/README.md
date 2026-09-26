# OpenCode read-receipt proof

Contract: `docs/product/internal-mode/read-receipts.md#opencode-read-receipts`.

OpenCode acknowledges a shared Khala batch only when the agent's own next
authenticated Khala call (`khala_read` or `khala_send`) echoes the batch token as
`ackBatchToken`. Delivery, the stored prompt, the steer transform, hints and the
batch response never acknowledge. The plugin keeps no cursor, lease or receipt
ledger; the inbox and the connector's receipt ledger own both.

## What is proven offline

`packages/agent-cli/src/opencode/receipts.test.ts` runs the real bridge over the
real inbox and the real connector receipt ledger:

| Case | Result |
|---|---|
| idle delivery, stored prompt, repeated hint | no receipt |
| busy steer mark + transform | no receipt |
| no later Khala call | neutral: no receipt, batch stays outstanding |
| next `khala_read` / `khala_send` with the token | one `agent_acknowledged` receipt |
| missing token | batch re-returned, no receipt |
| duplicate token | no second receipt |
| wrong token, other binding, no credential, stale generation | refused or ignored, no receipt |
| plugin restart before the next call | token retained, acknowledged exactly once |

Wrong-implementation check: with the bridge's `acknowledgeToken` forwarding
removed (`#readForTool` in `bridge.ts`), six of these nine tests fail.

```sh
pnpm --filter @aiur/khala exec vitest run --config ../../vitest.config.ts src/opencode/receipts.test.ts
```

## What is not yet proven

The offline tests do not establish support for a user-started OpenCode TUI. The
retained #180 evidence was agent-launched with default settings, so the
`batch_token_next_call` claim for OpenCode `1.17.10` + DeepSeek stays unproven for
a person-started session until a run is retained here as `evidence/live-run.json`.
Until then treat the pair as `unknown` for the person-started case.

`verify.mjs` defines the retained-report contract: user-started TUI (default trust
settings, no bypass flag, not `opencode run`/`serve`/`web`), exact OpenCode
version, DeepSeek provider/model, a recorded plugin route, and the ten
redacted cases in `REQUIRED_CASES`. Artifacts carry only kebab-case correlation
labels and presence/equality results; the scan rejects token bytes, digests and any
token-named string field.

```sh
node --test test/*.test.mjs        # mutation tests for the verifier
node verify.mjs evidence/live-run.json
```

A live run needs a person to start the TUI, join a channel, and let DeepSeek make
the next Khala call; it must not be simulated by an agent-launched session.
