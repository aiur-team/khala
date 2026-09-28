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

The focused package tests use the on-disk KHA-115 SQLite ledger, KHA-120 trust
transitions, KHA-121 dispatch precheck, KHA-134 review handler and this ticket's
handler, port and registrations. Handler tests use an in-memory trust store;
production instead opens a private SQLite trust journal. Browser tests verify the
protected mailbox client and mount the controls panel against a scripted status
client. These are local checks, not a real-service acceptance run.

| Claim | Test |
| --- | --- |
| A pause is effective only once `applyEffectivePolicy` commits it. The ack echoes command, binding, generation and the committed version | `apps/connector/src/composition/controls/control-handler.test.ts` |
| Approved work is held at the dispatcher's precheck (`paused`) after the pause commits, and proceeds after resume without a new approval (R1, R4) | `control-handler.test.ts` |
| Wrong owner, stale generation and stale version refuse before any policy write. Another binding, extra body fields and smuggled owner fields are refused | `control-handler.test.ts` |
| Hosted `auto` never becomes effective | `control-handler.test.ts` |
| Two tabs with the same expected version: exactly one wins, and the other gets `stale_policy` without overwriting (AE1) | `control-handler.test.ts` |
| A failed ledger write answers `pending`/`outcome_unknown`, and status shows it as requested, not effective. A retry with the same command ID enforces it once, and changed input is `idempotency_conflict` (AE2) | `control-handler.test.ts` |
| A request accepted before a crash is enforced by `reconcile` before new commands are served. While it cannot be enforced, a newer command is refused without a write | `control-handler.test.ts`, `register.test.ts` |
| A retry of a command that was enforced and then superseded answers `effective`. A command enforced first by a concurrent caller is not reported as rejected | `control-handler.test.ts` |
| A trust store behind the ledger starts again from what the ledger enforces | `control-handler.test.ts` |
| A lost submit publishes nothing, so the panel's same-command retry survives. A refused read shows offline, and a hung read is abandoned | `apps/web/src/composition/controls/browser-port.test.ts` |
| A command from an older binding generation replayed after a rebind is `stale_binding`. The new generation starts from what the ledger enforces | `control-handler.test.ts` |
| The capability handle exposes no policy entry point. The handler is served only on the protected transport, once, and a stop during reconciliation keeps it closed | `register.test.ts` |
| The browser reads only a strictly decoded status for its own binding. It keeps null versions null, keeps the last enforced values labelled offline when the connector is unreachable, and drops an older generation | `apps/web/src/composition/controls/browser-port.test.ts` |
| A malformed, mismatched or lost acknowledgment is unknown, never success | `browser-port.test.ts` |
| Through the real KHA-126 controller, a pause reads `offline` while the connector is unreachable and becomes effective only from the reconnected status | `browser-port.test.ts` |
| Route teardown disposes every port, observer and poll | `browser-port.test.ts` |
| The authenticated browser client sends owner-scoped status and review-only policy commands with CSRF, pins the exact retry body, and does not treat a later denial as proof an earlier lost write failed | `apps/web/src/composition/controls/owner-mailbox-client.test.ts` |
| The mounted room discovers the current binding, renders the actual controls panel, sends a versioned pause, and discards an old binding/account status response | `apps/web/src/composition/human/review-room.browser.spec.ts` |
| A delayed harness inspection cannot pair a tested capability with a replacement binding generation | `apps/connector/src/composition/controls/control-handler.test.ts` |

## Not yet proven, and why

No `*.spec.ts` lives here yet. A skipped or fixture-backed spec must not count as a pass.

- **Real protected-browser and process proof.** The owner mailbox route, production
  client, SQLite trust journal, initial policy and panel mount now exist, but the
  mounted browser fixture uses a scripted client. A disposable live run must prove
  wrong-owner/model refusal, exact connector acknowledgment, stale-version conflict,
  transport loss, restart reconciliation and re-arm against the actual process.
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
