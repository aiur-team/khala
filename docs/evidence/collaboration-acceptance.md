# Collaboration acceptance (KHA-139)

KHA-139 proves the chosen collaboration task end to end. Two humans and their existing
agent sessions complete it, and then an independent third owner joins. This report
records each acceptance run under its own run ID. Blocked and failed runs stay here.

**Status: blocked.** No live collaboration has run. The product decisions that define
the task and what may run are still open. The suite in `tests/e2e/collaboration/`
refuses to act until they clear.

## Gates

| Gate | State | Effect on this case |
| --- | --- | --- |
| G-TASK / P05: first collaboration task and success evidence | Open: asked, unanswered | Blocks the whole case before any action. No task content or success assertion is invented |
| G-HARNESSES: which harness routes the task runs on | Open: P15 reframed it, and only per-route tested evidence counts | Blocks the whole case before any action |
| G-AUTOMATION: busy, unattended, trust backlog and reply budgets | Open. Hosted `auto` is refused (`CLOSED_AUTOMATION`) | Blocks `trusted_delivery`, `rearm_waits` and `busy_notified_then_consumed` |
| P02: agent conversations with browsers closed | Open: asked, unanswered | Blocks `browser_closed`. The mode stays `unresolved` rather than being waived |
| G-RETENTION: recovery, closure and history on admission | Settled for this case by P12, P13 and P14 | Third owner sees no earlier history by default. Recovery has no backfill |

The KHA-139 plan names "KHA-109's approved collaboration scenario" as the source of
the task. KHA-109 is the backend restore and upgrade proof and holds no such scenario.
The decision it means is P05/G-TASK.

## Assertions

Each row passes only on live evidence (`live-sdk` or `live-harness`) that a scenario
issued, from exactly the harness versions the case pinned. A row behind an open gate
reports `blocked`, and the run is then not a pass.

| Assertion | Covers | Unit | Needs | Proves |
| --- | --- | --- | --- | --- |
| `ordinary_onboarding` | R1 | U2 | | A, B and C sign in with OAuth, join by link and bind an existing session. Any human connector configuration fails the row |
| `exact_review_release` | R2, AE1 | U2 | | B previews each message before releasing it, and no message reaches B's model before B releases it |
| `no_unreleased_consumption` | R2, AE1 | U2 | | For every owner, each `model.input` or `context.consumed` follows that owner's own review release, or an auto-release under that owner's effective, not re-armed trust |
| `session_identity_retained` | AE1 | U2 | | Every model input for A and B matches the original session identity. No identity change is recorded |
| `useful_task_result` | R1, AE1 | U2 | G-TASK | Each success assertion the approved task names is recorded against a message a model consumed, not merely echoed |
| `trusted_delivery` | R2 | U3 | G-AUTOMATION | B's trusted mode is requested, then effective, then used |
| `rearm_waits` | R2 | U3 | G-AUTOMATION | After B re-arms review, a later message waits for review again |
| `third_owner_independent` | R2 | U3 | | C onboards with its own identity. Nothing reaches C's model without C's own release or C's own trust decision |
| `third_owner_history` | R2 | U3 | G-RETENTION | C's admission point is recorded, and C reads nothing from before it |
| `busy_notified_then_consumed` | R3, AE2 | U4 | G-AUTOMATION | A busy recipient's message is queued and later consumed. The two are observed and timed separately |
| `offline_not_consumed` | R3, AE2 | U4 | | A relay acceptance while offline is not consumption. Catch-up after reconnect is. An unknown outcome is not later credited |
| `browser_closed` | R3 | U4 | P02 | When P02 requires it, a session consumes a message with the browser closed |
| `recovery_without_backfill` | R3 | U4 | | Recovery completes with no history backfill (P14). Other KHA-136 limits, such as duration, are not measured here |

## Standing limitations

- Timing is reported only as durations on one owner's monotonic clock. No cross-host
  latency or latency SLO is claimed.
- A relay or transport receipt is never counted as model consumption.
- Isolation from an unrestricted agent on the same host is not claimed. KHA-138 owns
  hostile security proof.
- No live collaboration driver exists yet. The KHA-134 and KHA-135 compositions
  still lack a protected human control transport, and nothing in production starts the
  connector runtime (`tests/integration/review/README.md`,
  `tests/integration/controls/README.md`). A live driver can exercise them only once
  those exist.

## Runs

### Run `collab-2026-09-26t063951380z-be94f335`

- Case: `two-owners-then-third`
- Outcome: **blocked**
- Source: `6bc22b5`, evidence mode `none, blocked before action`, 2026-09-25

Blocked before any action:

- G-TASK is open: P05: which first collaborative task (cross-repo coordination, technical Q&A or open-ended collaboration) and what success evidence (docs/product/decisions.md#P05; ticket-graph external_gates G-TASK)
- G-HARNESSES is open: which harness routes the chosen task runs on; P15 reframed the gate and only per-route tested evidence counts (docs/product/decisions.md#P15; ticket-graph external_gates G-HARNESSES)
- no approved collaboration task is recorded
- no harness version is pinned for the case

| Assertion | Covers | Outcome | Evidence or reason |
| --- | --- | --- | --- |
| `ordinary_onboarding` | R1 | blocked | not run: case blocked before action |
| `exact_review_release` | R2, AE1 | blocked | not run: case blocked before action |
| `no_unreleased_consumption` | R2, AE1 | blocked | not run: case blocked before action |
| `session_identity_retained` | AE1 | blocked | not run: case blocked before action |
| `useful_task_result` | R1, AE1 | blocked | not run: case blocked before action; also needs G-TASK |
| `trusted_delivery` | R2 | blocked | not run: case blocked before action; also needs G-AUTOMATION |
| `rearm_waits` | R2 | blocked | not run: case blocked before action; also needs G-AUTOMATION |
| `third_owner_independent` | R2 | blocked | not run: case blocked before action |
| `third_owner_history` | R2 | blocked | not run: case blocked before action |
| `busy_notified_then_consumed` | R3, AE2 | blocked | not run: case blocked before action; also needs G-AUTOMATION |
| `offline_not_consumed` | R3, AE2 | blocked | not run: case blocked before action |
| `browser_closed` | R3 | blocked | not run: case blocked before action; also needs P02 |
| `recovery_without_backfill` | R3 | blocked | not run: case blocked before action |

Limitations:

- Latency is reported only as durations on one owner's monotonic clock; no cross-host latency is claimed.
- A relay or transport receipt is not model consumption; only context.consumed or model.input counts.
- Isolation from an unrestricted agent on the same host is not claimed.
- No live collaboration was executed.
