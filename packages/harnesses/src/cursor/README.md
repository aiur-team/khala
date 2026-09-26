# Cursor app harness adapter

`createCursorHarness({ probe, clock, limits })` from `@khala/harnesses/cursor/index`
implements the `HarnessPort` for the Cursor app shapes in
[`interactive-desktop-apps.md`](../../../../docs/product/internal-mode/interactive-desktop-apps.md).

**Status: fail-closed.** The 2026-09-25 proof
([`cursor-app`](../../../../experiments/interactive-cli/cursor-app/README.md)) kept every
Cursor cell Blocked, so `CURSOR_ROUTE_PROOFS` is empty. Every mode reports `unknown`,
no hook boundary is named, and `acknowledgement` is `unknown`. Khala never launches,
hosts or pushes into Cursor, so `submit` always returns a connector-side `failed`
(`harness_unavailable`) receipt. `notify` does nothing, and `reconcile` returns `null`.

## Capability record

`cursorAppRecord(inspection, limits)` returns an `AppHarnessRecord` keyed by the full
tuple: shape (`local_chat` or `cloud_task`), Cursor version, account tier and
administrator policy scope. A mode is `proven` only when a proof covers that exact
tuple. Any field that could not be inspected (`null`) matches no proof. A `cloud_task`
proof never covers a `local_chat` session, and the reverse holds too. A proven cell sets
the mode's boundary (`postToolUse`, `stop` or `khala_read`) and
`acknowledgement: batch_token_next_call`, because every graded trial requires
acknowledgement on a later agent call. `steer` and `sync` carry the decision 34/37
claim that idle agents receive messages only at their next turn.

A proof is added only together with the `matrix.json` cell that proves it. A unit
test fails whenever the table and the committed matrix disagree.

## Receipts

`cursorReceiptKind(observation, record)` credits a Cursor observation:

| Observation | Earns |
| --- | --- |
| Cursor accepted a `postToolUse` or `stop` hook's output | `harness_queued`, only if that mode is proven; never `context_consumed` |
| `khala_read` returned the batch | `harness_queued`, only if `async` is proven |
| A later agent call presented the batch token | `agent_acknowledged`, only with `batch_token_next_call` |

Cursor reports no model-context consumption to a hook or MCP server, so no Cursor
observation is ever `context_consumed`.
