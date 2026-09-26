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
| `khala_read` and `khala_send` racing the same token | serialized: one receipt |
| recording failure on the acknowledging call | fails closed: no receipt, same batch and token replayed, the retry acknowledges once |
| direct competing inbox consumer (second listener) | `listener_busy`, no receipt |
| lost token, or an older token against a later batch | same token re-returned, never regenerated; the older token acknowledges nothing |

Wrong-implementation check: with the bridge's `acknowledgeToken` forwarding
removed (`#readForTool` in `bridge.ts`), ten of these thirteen tests fail; with the
inbox's `#recordAcknowledgement` call removed, the same ten fail.

```sh
pnpm --filter @aiur/khala exec vitest run --config ../../vitest.config.ts src/opencode/receipts.test.ts
```

## What is not yet proven

No live run is retained by this change, so it advertises no capability change.
Main already advertises `batch_token_next_call` for OpenCode `1.17.10`, which comes
from #180's agent-launched, default-settings TUI run. Under decisions 33 and 43 the
Executor runs the live OpenCode + DeepSeek run later and retains it here as
`evidence/live-run.json`; the offline tests above do not replace it.

`verify.mjs` defines the retained-report contract: a run honestly labelled
`user-started-tui` or `agent-launched-default-settings`, default trust settings (any
`--dangerously*`, `--yolo` or `--auto-approve` flag fails; `--pure` is allowed), the
exact launch command(s) in a non-empty `launches`, the OpenCode session ID, exact
OpenCode version, DeepSeek provider/model, a recorded plugin route, not
`opencode run`/`serve`/`web`, and the ten redacted cases in `REQUIRED_CASES`. Artifacts carry only kebab-case correlation
labels and presence/equality results; the scan rejects token bytes, digests and any
token-named string field.

```sh
node --test test/*.test.mjs        # mutation tests for the verifier
node verify.mjs evidence/live-run.json
```

A live run needs a real OpenCode TUI, a joined channel, and DeepSeek making the
next Khala call, with its `startedBy` label stating truthfully who launched it.
