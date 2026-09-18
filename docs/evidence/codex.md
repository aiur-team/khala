# Codex existing-session attachment

**2026-09-18: attaching to an existing executor is unproven.** What was proven is
narrower. It holds for codex-cli **0.154.0** only.

- **Proven.** Khala starts its own `codex app-server --listen unix://…` and resumes a
  dormant thread in it with `thread/resume`. A second client connection on that
  listener can then use `thread/queue/add` to deliver a released nonce. The nonce is
  consumed under the original thread ID, by the executor Khala started, with
  settings unchanged, and the reply recalls the prior context marker. Idle and busy
  delivery, one disconnect case, a duplicate-executor control and exit all ran
  against the designated disposable fixture.
- **Not proven: attaching to an executor Khala did not start.** In every run the
  target was `notLoaded` until the driver's own app-server resumed it, and "same
  executor" means that host. Delivering into a thread that a human's `codex` TUI,
  `codex exec`, an IDE or another app-server already hosts was never exercised. Plan
  R2 warns against inferring that from resume APIs.
- **A thread that another writer already holds cannot be reached this way.** A
  second executor's `thread/resume` is refused with `already has an active writer`
  (the duplicate-executor case).

AE1 passes only in that reframed sense: the session is existing and dormant, and
Khala hosts it. AE2 is exercised and holds. See
[Limits](#limits-that-bind-kha-106-and-kha-118).

## Fixture and consent

Executor designation (issue #13, 2026-09-18T02:38Z): disposable thread
`01a0b261-639c-7cf1-a6b0-f485ee08dfac`, created with `codex exec` for this test.
Its workdir is an empty scratch directory under `~/.cache/khala-disposable/`. The
operator authorized live cases against this thread only. The live driver now
refuses any other thread ID, any workdir outside that root, a thread whose native
`cwd` differs from the workdir, and a thread another process holds
(`guards.ts`, tested in `guards.test.ts`).

**Before consent, one other session was contacted.** On 2026-09-16, before any
target had been designated, the read-only preflight (`probe.ts`) tried a
metadata-only `thread/read` against a real, non-disposable session (this ticket's
own agent session). It failed at transport, before initialization, so nothing was
read or written. Its ID has been redacted from
[preflight.json](../../experiments/codex/evidence/preflight.json); it remains in
this branch's earlier commits. The live runs touched no thread except the fixture.

Before the runs, the fixture thread held `prior-marker-codex-alpha` from an earlier owner turn
([exploration notes](../../experiments/codex/evidence/exploration-notes.md)).
Delivered text asks for "the prior context marker you were asked to remember" and
never contains the marker, so a correct reply shows recalled context.

Settings at load, unchanged through every case (`settingsPreserved: true`): approval
`never`, sandbox `readOnly` with network access off, reasoning effort `medium`, the
fixture workdir, and the fixture's original model.

## Route

1. **Setup (agent, recorded).** Start `codex app-server --listen unix://<scratch>/exec.sock`
   in the fixture workdir. An owner connection calls `thread/resume {threadId,
   excludeTurns:true}` with no model, cwd, approval or sandbox overrides. The
   app-server's native binary then holds the thread-writer flock
   `~/.codex/thread-writer-locks/<threadId>.lock`. That PID is the executor identity.
2. **Notify.** A separate WebSocket client on the same Unix listener calls
   `thread/queue/add {threadId, clientUserMessageId, input}`. The listener speaks
   WebSocket; `app-server proxy` only forwards raw bytes, so a plain JSONL client
   hangs at `initialize`.
3. **Consumption.** The executor starts a turn itself. The native `userMessage` item
   carries `clientId == clientUserMessageId`, which correlates the consumption with
   the delivery from native events rather than from generated text.

No human setup was needed. No human connector, credential copy, config change or
permission change was involved.

## Results — clean run `bff6ff3b`

Report: [live-run.json](../../experiments/codex/evidence/live-run.json)
(sha256 `7cc07e17871b68b37288d31e2c474efbb627e22d9566b561c9ae9fa380618ad6`).
Times are milliseconds on one monotonic clock in the driver process. This report
was written by the driver before e7562f0. Its `acceptance` fields came from code that
compared the original executor PID with itself, so the file now carries an
`annotation` marking them stale. The verdicts in the table below are re-derived from
the recorded facts (`acceptance.test.ts`). Every published report has since had the
model name and the agent scratch path replaced with placeholders, which changed the
hashes.

| Case | What happened | Same-session acceptance |
|---|---|---|
| Idle | Status `idle`, empty queue. Queue ack at 366.9, `userMessage` consumed at 1408.1, turn completed at 5739.2. Reply: `release-nonce-bff6ff3b-idle prior-marker-codex-alpha`. | accepted, no failures |
| Busy | The owner started a controlled `sleep 25` tool call (started 12947.2). Queue ack at 12968.6 while `active`. The tool ran to completion (exit 0, 24871 ms), and the busy turn completed at 40987.9. The nonce was consumed in a **new** turn at 41009.6, 22 ms later. The tool was not interrupted and the nonce was not injected into the busy turn. | accepted, no failures |
| Disconnect | During a `sleep 30` tool call, the notifier wrote `queue/add` (flushed at 50953.0) and dropped the socket with no close handshake. It never saw a response. A reconcile client found **1** pending entry with that `clientUserMessageId`. Replaying the same request with the same ID was **accepted as a second entry** (2 pending). The driver deleted the duplicate by `queuedSubmissionId`, leaving 1. That entry was consumed once after the tool finished (82807.9). | accepted, no failures |
| Duplicate executor | A second `codex app-server` on another socket tried `thread/resume` on the same thread and got `-32600 thread … already has an active writer`. The writer lock stayed with the original native PID and the rollout was byte-identical. No input was sent. Had a duplicate consumed with copied history, acceptance would fail on `thread_id_changed` and `executor_process_changed`. | rejected, as AE2 requires |
| Exit | Stopping the executor emptied its process group and released the writer lock. A WebSocket connect then failed, `codex queue --remote unix://<sock> --thread …` exited 1 with "No such file or directory", no replacement process appeared, and the rollout was unchanged. | delivery fails closed |

Acceptance (`experiments/codex/acceptance.ts`) requires all of these: same native
thread ID; the same native executor PID before delivery, at consumption and as
lock holder; exactly one consumed `userMessage` for the client ID; nonce and prior
marker in the reply; the marker absent from the delivered text; and model, cwd,
approval, sandbox and reasoning effort unchanged. Each case must also have actually
exercised its state. For idle, the queue drained and the status was `idle` at
delivery. For busy and disconnect, delivery landed while the controlled command was
running, the command completed with exit 0, and the nonce was consumed in a later
turn rather than injected into the busy one.

In run `bff6ff3b`, the executor at consumption was not sampled on its own. It holds
by construction, since only the original executor listens on the socket that carried
the event, but that is not the same as observing it. The writer-lock holder was
sampled after each case, not at consumption. The case conditions were checked
afterwards from the recorded facts (`acceptance.test.ts`). The driver was then
tightened and re-run.

## Re-run with the tightened driver — run `d2eaf702`

Report: [live-run-v2.json](../../experiments/codex/evidence/live-run-v2.json)
(sha256 `f3c5143724ffb2146f3a0e10bf42fb208dd1741661be5c0b600c850a64153fcc`).
At each consumption, the driver now reads which process listens on the executor
socket (`/proc/net/unix`) and which process holds the writer lock (`/proc/locks`).
Case conditions are part of the verdict. Every case passed.

| Case | Delivery | Consumption | Executor at consumption |
|---|---|---|---|
| Idle | Queue drained and `idle`. Ack at 348.6. | 1620.1, one entry | listener = lock holder = original |
| Busy | Ack at 11536.5 while `active`, during `sleep 25` (11519.7–36398.2, exit 0) | 38314.3, in a new turn | listener = lock holder = original |
| Disconnect | Write flushed at 48734.4 during `sleep 30` (48719.2–78588.2, exit 0). The same-ID replay created a second entry, which was deleted. | 80772.3, once, in a new turn | listener = lock holder = original |
| Duplicate executor | `thread/resume` got `-32600 … already has an active writer`, and the rollout was unchanged | none | rejected, as AE2 requires |
| Exit | Process group emptied and lock released. `codex queue --remote` exited 1 and no replacement process appeared. | none | delivery fails closed |

## Re-run with the guarded driver — run `9a28af84`

Report: [live-run-v3.json](../../experiments/codex/evidence/live-run-v3.json)
(sha256 `df1771959671a6839033b9b000c9546ad72f3b94dad5063614c2527d211dfd1a`),
2026-09-18. Before resuming, the driver checked the target allowlist, confirmed that
no process held the lock, and confirmed that the thread's native `cwd` was the
fixture workdir. The thread was `notLoaded`, so this run too covers a dormant thread
that the driver hosted, not attachment to a running one. The disconnect replay was
off (`replayProbe: false`).

| Case | Delivery | Consumption | Executor at consumption |
|---|---|---|---|
| Idle | Queue empty at load and `idle`. Ack at 1096.0. | 2109.8, one entry | listener = lock holder = original |
| Busy | Ack at 11614.0 while `active`, during `sleep 25` (11593.8–36465.6, exit 0) | 40060.0, in a new turn | listener = lock holder = original |
| Disconnect | Write flushed at 46949.2 during `sleep 30` (46935.4–76805.2, exit 0), then the socket was dropped. Reconcile found 1 pending entry. There was no replay and nothing was deleted. | 82056.8, once, in a new turn | listener = lock holder = original |
| Duplicate executor | `thread/resume` got `-32600 … already has an active writer`, and the rollout was unchanged | none | rejected, as AE2 requires |
| Exit | Process group emptied. After the WebSocket and `codex queue --remote` attempts, no process held the writer lock, and no replacement or new `app-server` process appeared. The rollout was unchanged. | none | delivery fails closed |

## Findings from the earlier, interrupted runs

Three earlier runs are kept because they surfaced two delivery-safety facts.

- **`clientUserMessageId` does not deduplicate.** In run `a629e936`, the replayed
  same-ID entry was not deleted (a wrong delete parameter, since fixed), and the
  executor consumed **both** entries: two turns replied with
  `release-nonce-a629e936-disconnect`. That run's executor became an orphan, and I
  stopped it after seeing this. Run `093e1307` stopped at the same step, and its
  two same-ID entries were later consumed twice as well.
- **The queue survives executor exit and drains on the next load.** Run `093e1307`
  left two entries queued when its executor was stopped. In run `028dd119`,
  resuming the thread in a new executor drained both before any new delivery. That
  run's "idle" delivery was therefore actually made while `active`, so it is
  treated as a drain observation, not idle evidence:
  [live-run-drain.json](../../experiments/codex/evidence/live-run-drain.json)
  (sha256 `18d623c81f766e57766bf660ae8155dc5e1e2d863bc0f67a674a0ccfd0a89e4a`;
  its `acceptance` fields are annotated as stale, like `live-run.json`'s).
  The driver now waits for an empty queue and `idle` before the idle case.
- Run `a1ea05d6` confirmed idle consumption and then stopped mid-busy when its
  agent session ended. Its orphaned executor later consumed the queued busy nonce.

## Limits that bind KHA-106 and KHA-118

- **Khala-hosted, dormant threads only.** The thread was `notLoaded` until the
  agent-started app-server resumed it (a recorded setup step), and the delivery went
  through that app-server's listener. Nothing here shows delivery into a thread that
  is already running in a TUI, `codex exec`, an IDE or another app-server. A
  human-started TUI exposed no reachable control socket in the 2026-09-16 preflight
  (`<HOME>/.codex/app-server-control/app-server-control.sock` absent), and a thread
  that another writer holds refuses a second `thread/resume`. KHA-118 must either
  host sessions behind its own app-server listener from the start, or get new
  evidence for attaching to another executor.
- **Disconnect coverage is narrow.** Only one disconnect shape was tested: while
  busy, the full `queue/add` frame was flushed and then the socket was dropped
  before the response arrived. The entry was durably queued and consumed once. An
  idle-time drop and a write lost before it reached the listener were not tested.
- **Replay is unsafe.** A queue receipt is not consumption, and a missing receipt
  is ambiguous. Runs `bff6ff3b` and `d2eaf702` replayed the same
  `clientUserMessageId` once to observe this, which plan U3 only allows once dedup is
  established. That replay is now opt-in (`replayProbe`) and off by default. Reconcile with `thread/queue/list` filtered on
  `clientUserMessageId`, and never re-add blindly: a replay creates a duplicate
  that is executed. After a turn has started, dedup must come from the connector
  (for example, checking consumed `userMessage.clientId` in `thread/read` turns),
  not from Codex.
- **Durable queue.** An entry queued when the host exits is consumed by whichever
  executor loads the thread next, including a resumed process. An adapter that
  requires same-executor delivery must drain or delete its own pending entries
  before releasing the executor. It must also treat a writer-lock PID change as
  a new executor.
- **Busy semantics.** Busy delivery waits for the running turn to finish and then
  runs as a new turn. `turn/steer` was not used and is not proven here.
- **Version pin.** Only codex-cli 0.154.0 on Linux x64 was tested. The live runs
  used Node 24.18.0. The offline tests pass on both 24.18.0 and the repository's
  pinned 22.23.2, and `engines` accepts exactly those two. Wire shapes come from the installed experimental schema
  ([schema/](../../experiments/codex/evidence/schema/), including
  `ThreadQueueDeleteParams.json`). No minimum-version claim is made.
- **Delivered text** is synthetic and non-secret. Real released content must not
  go in command arguments; the `codex queue --message` CLI route exposes text to
  process listings and was used here only for the fail-closed exit check.

## Reproduce

Local validation (no model), from the repository root with Node 22.23.2 (the
repository pin) or 24.18.0:

```sh
npm --prefix experiments/codex ci
npm --prefix experiments/codex run probe -- --help
npm --prefix experiments/codex run typecheck
npm --prefix experiments/codex test
```

The live driver and its input are described in
[experiments/codex/README.md](../../experiments/codex/README.md). It runs only
against an explicitly designated disposable thread that no other process holds.

Discovery evidence from 2026-09-16 stays valid:
[inventory.json](../../experiments/codex/evidence/inventory.json) (commands, schema
and output hashes) and the official
[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
