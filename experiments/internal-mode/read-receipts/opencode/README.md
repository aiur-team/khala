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

## Native proof retained

The Executor ran OpenCode `1.17.10` with `deepseek/deepseek-flash` in the normal
interactive TUI on 2026-09-27 UTC. The run is honestly labelled
`agent-launched-default-settings` under decisions 33 and 43. Its ten required
cases pass in [`evidence/live-run.json`](evidence/live-run.json); the observed
steps and limits are in [`evidence/live-run-2026-09-27.md`](evidence/live-run-2026-09-27.md).

All positive acknowledgements, the missing argument, and the duplicate argument
were actual model-initiated plugin calls. Wrong-token, wrong-binding and
wrong-generation negatives used authenticated HTTP diagnostics against the
actual pending native batch. Normal TUI reconnect and owner restart passed;
Stop left the native CLI alive and prevented later delivery. Main already
advertises this exact version's route; no new version or capability is enabled.
This receipt-integrated component build does not replace final hosted application
or cross-harness acceptance.

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
