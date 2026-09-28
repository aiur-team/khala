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

`manual-owner-controls.spec.ts` is a fail-closed live driver. It has not been run
and is not acceptance evidence. It uses the deployed HTTPS control routes, two
real OAuth sessions, a real pre-paired local connector process and the private
native witness documented below. It exercises the mounted owner panel,
connector acknowledgment, wrong-owner refusal, two-tab version conflict, a
browser reply lost *after* the actual submit, and a restart of the same
process/session. It then approves an exact event while pause is effective,
checks that the pinned native session did not see it during the paused
observation, resumes review delivery and requires its native ACK and cursor.
A separate event sent after effective review resume stays pending and absent
while its approved neighbor reaches the same native session. Hosted `auto`
and its re-arm remain gated. No skipped or fixture-backed spec counts as a pass.

- **Real protected-browser and process proof.** The owner mailbox route, production
  client, SQLite trust journal, initial policy and panel mount now exist, but the
  mounted browser fixture uses a scripted client. A disposable live run must prove
  wrong-owner/model refusal, exact connector acknowledgment, stale-version conflict,
  transport loss, restart reconciliation and event-level re-arm against the actual
  process. The new driver covers wrong-owner denial, acknowledgment, conflict,
  transport loss and restart, but has no qualifying run. Model-surface refusal
  and post-resume native model input remain unobserved until a qualifying run.
- **Live races.** U2 needs a disposable runtime with fault and barrier hooks between an
  incoming event, dispatch and a restrictive control. U3 is blocked by the gates above.

## Live run, once the prerequisites exist

Follow `tests/integration/human/README.md` for disposable identities, deployment and an
already-running harness session. The same secret-free JSON descriptor must also
contain:

```json
{
  "controls": {
    "roomId": "!disposable-room:server",
    "bindingId": "binding-from-real-pairing",
    "agentParticipantId": "agent-from-real-pairing",
    "connectorControl": {
      "executable": "/absolute/path/to/node",
      "args": ["/absolute/path/to/tests/integration/controls/connector-control.mjs", "/absolute/path/to/private-control.json"],
      "processExecutable": "/absolute/path/to/node",
      "processCwd": "/absolute/path/to/disposable-agent-workspace",
      "processCgroup": "/user.slice/user-1000.slice/.../khala-e2e-connector-aabbccddeeff.service"
    }
  }
}
```

The operator must approve and provision a disposable hosted deployment with
real OIDC, Matrix/Synapse, persistent control store and explicit browser
admission, plus a pre-paired owner connector attached to an already-running
supported native session. The descriptor's first OAuth user owns `roomId` and
the binding; the second user has a separate real identity and is already admitted
to the room to send synthetic events. The agent participant
and binding IDs must come from the deployed binding, not a seeded stand-in.
The local `connectorControl` executable is a process supervisor adapter, not an
HTTP or mailbox substitute: `<args> status` reports JSON
`{pid,bindingId,generation,sessionId}` for the live process, while `<args> restart`
restarts that exact connector and reports the same fields with a new PID. It
must refuse any other instance, preserve the native session and durable store,
return within 30 seconds, and keep secrets out of stdout/stderr. The test also
checks `/proc/<pid>` executable, working directory, exact cgroup, start time
and that the old process has exited. This lifecycle adapter does not
decide owner authority or policy; all commands still cross production routes.
`connector-control.mjs` implements this contract for one systemd user unit. Its
private config file (owned by the current user, mode 0600) has this shape:

```json
{
  "v": 1,
  "unit": "khala-e2e-connector-aabbccddeeff.service",
  "unitFragment": "/absolute/path/to/user/unit/file",
  "harness": "codex",
  "sessionId": "the-existing-native-thread-id",
  "bindingId": "binding-from-real-pairing",
  "generation": 1,
  "stateRoot": "/absolute/path/to/XDG_STATE_HOME/khala/hosted",
  "workdir": "/absolute/path/to/the-native-session-workspace",
  "processExecutable": "/absolute/path/to/node",
  "processCwd": "/absolute/path/to/the-native-session-workspace",
  "processCgroup": "/exact/user.slice/path/to/khala-e2e-connector-aabbccddeeff.service"
}
```

The adapter accepts only a `khala-e2e-connector-<12 hex>.service` owned user
unit. It compares systemd's MainPID, unit fragment and control group with the
actual `/proc` process and the stored `current-binding.json` at the production
session hash. It restarts only that exact unit and refuses changed session,
binding, generation or process identity. The unit must launch or resume the
*same* provider-named Codex session with the installed Khala MCP entry and
already established binding; `khala mcp-serve` from an ordinary shell has no
provider thread metadata and does not create an active owner connector by
itself. This change does not provision a unit or start a native process.
After restart, the test must still get a fresh connector status through the
protected mailbox, so a PID-only restart cannot count as success.

The same private descriptor must include `reviewNative` as specified in
`tests/integration/review/README.md`. Its process and rollout identify the
already-running Codex 0.157.1 GPT-6-Sol session named by protected connector
status. The driver reads only new rollout intervals and the production CLI
inbox/cursor. Missing or changed process, model, rollout, ACK, cursor or
pending neighbor fails the test. The descriptor must be an owned mode-0600
regular file; credentials and rollout contents stay outside test output.

The driver also requires the deployed browser bundle to include the owner
controls wiring and the connector to inspect a *tested* manual route. A disabled
button or unavailable status is a failure. The native witness checks an event
arriving after effective review resume against an independently approved
neighbor. This does not prove a transition from hosted `auto` back to review;
that transition remains blocked by G-AUTOMATION. A finite absence observation
does not claim to retract already consumed content.

Run only after these prerequisites are approved and available:

```sh
KHALA_E2E_LIVE=1 \
KHALA_E2E_DISPOSABLE_ENV=/absolute/path/to/khala-live.json \
pnpm test:integration tests/integration/controls
```

Evidence joins command ID, requested and enforced policy versions, and UI state. Use
`projectControls` for it, never raw status or message content.

The older `docs/evidence/collaboration-acceptance.md` describes an Executor
ruling for P02/G-AUTOMATION, while the current #44 plan and this README still
hold P02/P08/G-AUTOMATION open for hosted controls. This source change records
the conflict without treating either document as permission to enable `auto`,
browser-closed delivery or a budget policy.
