# Collaboration acceptance (KHA-139)

The launch proof: two owners complete the approved task through their existing agent
sessions, then an independent third owner joins. The report lives in
`docs/evidence/collaboration-acceptance.md`.

## Modules

- `scenario.ts`: `RECORDED_DECISIONS` holds the gates this case reads, as recorded in
  `docs/product/decisions.md` and the ticket graph. `bindCase` is pure. While G-TASK or
  G-HARNESSES is open, or no task is approved, it returns `blocked` before any owner,
  session or driver is touched. Other open gates (G-AUTOMATION, G-RETENTION, P02) block
  only the rows that name them. A case with no pinned harness version is also blocked.
  Owners A, B and C must share no verified identity.
- `assertions.ts`: one check per row, over live evidence records. Order is compared
  only within one owner's clock. A `model.input` or `context.consumed` counts only
  after that owner's own release. That means by review, or by an auto-release under
  that owner's trust while it was effective and not yet re-armed. `relay.accepted`
  never counts as consumption, and an `outcome_unknown` receipt cannot later be credited
  without new evidence.
- `evidence.ts`: `evaluate` fails every row for fake or hand-built evidence, or for
  evidence whose sources lack the pinned harness versions. It keeps rows behind open
  gates `blocked`, so the run cannot pass. `measure` reports
  queued→consumed and released→input durations on the recipient's own clock.
  `appendRun` refuses a run ID the report already holds, so reruns never overwrite
  adverse evidence.

## Evidence kinds a live driver records

Every record is `(kind, ownerId, operationId)` and carries no content.

| Stage | Kinds |
| --- | --- |
| Onboarding | `setup.oauth_signed_in`, `setup.link_joined`, `setup.session_bound`, `setup.human_configured` (any one fails R1) |
| Review | `review.pending`, `review.previewed`, `review.released`, `model.input`, `session.identity_matched`, `session.identity_changed` |
| Task | `task.<id>` for each assertion the G-TASK decision names, recorded against the release it answers |
| Trust | `trust.requested`, `trust.effective`, `trust.auto_released`, `trust.rearmed` |
| Third owner | `history.admitted`, `history.pre_admission_read` |
| Busy and offline | `session.busy`, `delivery.queued`, `context.consumed`, `presence.offline`, `presence.online`, `relay.accepted`, `delivery.caught_up`, `harness.outcome_unknown` |
| Browser closed and recovery | `browser.closed`, `browser.opened`, `recovery.completed`, `recovery.backfill` |

## Running

```sh
pnpm test:e2e -- tests/e2e/collaboration/collaboration.test.ts
```

This runs the binding and evaluator checks on scripted `live-harness` records from a
test driver. They prove only that the evaluator judges evidence correctly. The live
entry is skipped.

```sh
KHALA_E2E_LIVE=1 \
KHALA_E2E_DISPOSABLE_ENV=/absolute/path/to/khala-live.json \
pnpm test:e2e -- tests/e2e/collaboration/collaboration.test.ts
```

This is the acceptance run. Today it fails with `CollaborationBlocked`, because
G-TASK and G-HARNESSES are open. Once they clear, it still fails until a live
collaboration driver is registered. A blocked live run is a failure, never a skip.

A real run needs:

- three designated owner accounts, each with its own device and an existing agent
  session;
- the selected deployment;
- the approved task.

Follow `tests/integration/human/README.md` for disposable identities. Never pass
tokens as arguments.
