# Trust and controls evidence (KHA-135)

KHA-135 wires the owner's trust, pause and status controls from the browser to the
connector's policy ledger. This file records what is proven today, what the open
product gates keep out of scope, and what a live run still needs.

## Product gates

P02 (conversations with browsers closed) is asked and unanswered. P08 (who may pause
and resume, turn budgets, tool authority) is not asked yet. G-AUTOMATION is open.
Following the ticket's stop condition, nothing here guesses them:

- Hosted `auto` is refused at the connector through `CLOSED_AUTOMATION` (#288). The
  browser receives a rejected acknowledgment with `errorCode: 'unavailable'`, and the
  enforced policy does not change.
- Pause and resume are owner-only, the authority KHA-120 already enforces. They hold
  and resume *delivery* at the dispatcher's claim. They never cancel an active model
  turn or recall content already released.
- Busy, offline and loop-bound behavior under approved automation (plan unit U3) is
  **blocked**. No approved budget, loop limit or unattended lifecycle exists to test
  against.

## Proven locally

These tests run in the normal package suites (`pnpm --filter @khala/connector-app test`,
`pnpm --filter @khala/web test`). They use the on-disk KHA-115 SQLite ledger, the
KHA-120 trust transitions, the KHA-121 dispatch precheck, the KHA-134 review handler
and this ticket's handler, port and registrations. Only the protected transport and the
durable trust store are stand-ins. The trust store is a serialized in-memory store.

| Claim | Test |
| --- | --- |
| A pause is effective only once `applyEffectivePolicy` commits it. The ack echoes command, binding, generation and the committed version | `apps/connector/src/composition/controls/control-handler.test.ts` |
| Approved work is held at the dispatcher's precheck (`paused`) after the pause commits, and proceeds after resume without a new approval (R1, R4) | `control-handler.test.ts` |
| Wrong owner, stale generation and stale version refuse before any policy write. Another binding, extra body fields and smuggled owner fields are refused | `control-handler.test.ts` |
| Hosted `auto` never becomes effective | `control-handler.test.ts` |
| Two tabs with the same expected version: exactly one wins, and the other gets `stale_policy` without overwriting (AE1) | `control-handler.test.ts` |
| A failed ledger write answers `pending`/`outcome_unknown`, and status shows it as requested, not effective. A retry with the same command ID enforces it once, and changed input is `idempotency_conflict` (AE2) | `control-handler.test.ts` |
| A request accepted before a crash is enforced by `reconcile` before new commands are served | `control-handler.test.ts`, `register.test.ts` |
| A command from an older binding generation replayed after a rebind is `stale_binding`. The new generation starts from what the ledger enforces | `control-handler.test.ts` |
| The capability handle exposes no policy entry point. The handler is served only on the protected transport, once, and a stop during reconciliation keeps it closed | `register.test.ts` |
| The browser reads only a strictly decoded status for its own binding. It keeps null versions null, keeps the last enforced values labelled offline when the connector is unreachable, and drops an older generation | `apps/web/src/composition/controls/browser-port.test.ts` |
| A malformed, mismatched or lost acknowledgment is unknown, never success | `browser-port.test.ts` |
| Through the real KHA-126 controller, a pause reads `offline` while the connector is unreachable and becomes effective only from the reconnected status | `browser-port.test.ts` |
| Route teardown disposes every port, observer and poll | `browser-port.test.ts` |

## Not yet proven, and why

No `*.spec.ts` lives here yet. A skipped or fixture-backed spec must not count as a pass.

- **Protected controls transport.** No route authenticates the human and forwards
  `OwnerAuthority` to `PolicyControlHandler`. `ControlsProtectedTransportPort`
  (connector) and `ControlsClient` (browser) are the seams. Until the transport exists,
  both registrations stay `unavailable`.
- **Durable trust store.** `TrustStateStore` has no durable implementation. It must
  keep KHA-120's command journal across restarts, or a retried command could be
  refused `stale_policy` after it was actually enforced. The connector capability
  stays `unavailable` until one is injected.
- **Route mount and binding lookup.** Same gaps as review (`tests/integration/review/README.md`):
  no render slot for `AgentControlsPanel`, and no contract gives the browser its
  binding ID or peer participant for a room.
- **Live races.** U2 needs a disposable runtime with fault and barrier hooks between an
  incoming event, dispatch and a restrictive control. U3 is blocked by the gates above.

## Live run, once the prerequisites exist

Follow `tests/integration/human/README.md` for disposable identities, deployment and an
already-running harness session. Then:

```sh
KHALA_E2E_LIVE=1 \
KHALA_E2E_DISPOSABLE_ENV=/absolute/path/to/khala-live.json \
pnpm test:integration tests/integration/controls
```

Evidence joins command ID, requested and enforced policy versions, and UI state. Use
`projectControls` for it, never raw status or message content.
