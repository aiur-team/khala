# Existing-session attachment experiment

**Status: live proof run on the designated disposable fixture. `thread/queue/add`
through an app-server Unix listener is supported for codex-cli 0.154.0, with limits.**
This isolated package inventories Codex 0.154.0 and contains a read-only preflight
probe (`probe.ts`) and the live fixture driver (`live.ts`). It is not a production
adapter. See [the evidence report](../../docs/evidence/codex.md).

## Reproduce local validation

From the repository root, using Node **24.18.0**:

```sh
npm --prefix experiments/codex ci
npm --prefix experiments/codex run probe -- --help
npm --prefix experiments/codex run typecheck
npm --prefix experiments/codex test
```

The test runner is Node's built-in `node:test`, pinned by the Node version; tsx,
TypeScript, Node types and transitive packages are pinned in this package's lockfile.
No root install is needed. Tests use fake JSONL subprocesses, never live models.
There is no lint configuration in this isolated package.

## Explicit target

The callable experiment API is `runAttachmentProbe(input)` in `probe.ts`.
`ProbeInput` retains the plan's fields and adds optional `release` (default false)
and `socketPath`. Reports include allowlisted `facts`; no conversation, raw remote
error, model name, workdir, socket path, or nonce is published. Native thread UUIDs
remain visible for identity checks. Queue IDs are hashed; the locally generated
operation UUID is retained for later investigation, not as a promise of deduplication.

Write the following JSON to a private workspace-local file under `$TMPDIR`, replacing
the target ID/workdir/socket with the **explicitly designated** target's values:

```json
{
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "expectedWorkdir": "/absolute/designated/workdir",
  "nonce": "release-nonce-7",
  "mode": "idle",
  "deadlineMs": 5000,
  "release": false
}
```

```sh
npm --prefix experiments/codex run probe -- --stdin < "$TMPDIR/kha104-target.json"
```

For machine-readable JSON without npm's banner:

```sh
experiments/codex/node_modules/.bin/tsx experiments/codex/scenario.ts --stdin \
  < "$TMPDIR/kha104-target.json" > "$TMPDIR/kha104-report.json"
```

The default only attempts proxy initialization and metadata-only `thread/read`.
It never scans sessions, reads history, launches a server, resumes/forks a thread,
starts a turn, changes settings, or copies credentials. `socketPath` selects an
already accessible control socket; omission uses the native proxy default.
Unknown CLI versions fail closed before connecting. Synthetic nonces must match
`release-nonce-[a-zA-Z0-9-]{1,64}`. Input is passed via stdin, not command arguments.

Only after a disposable session is explicitly designated and its prior marker,
executor identity and settings are independently recorded, `release: true` sends
one synthetic message with `thread/queue/add`. Matching metadata and requested
idle/active state are required first. No prior marker is included in that message.
The `busy` mode checks a native `active` snapshot; it does **not** establish that a
controlled tool is still running. The request has a fresh `clientUserMessageId`;
**do not rerun a release request after uncertainty**, because native replay semantics
are unproven. Cleanup closes/kills only this probe's proxy process, never the target.
The deadline bounds the process lifetime, followed by a 250ms kill grace period and
OS process reap. Input reading has a separate five-second/16KiB bound.

Even a queue receipt remains `inconclusive`: this implementation cannot certify
permissions, executor generation or prior-context consumption. It never returns
`supported`. After enqueue it checks workdir/model metadata again; this does not
establish permission preservation or consumed context. The retained operation ID
can help investigation, but there is no reconciliation implementation yet.

The live runs showed that `--listen unix://PATH` speaks WebSocket and `app-server
proxy` only forwards those bytes, so this JSONL-over-proxy probe hangs at
`initialize` against a real listener. It remains a guarded preflight. The live
driver below uses `ws-rpc.ts` instead.

## Live fixture driver

`live.ts` runs every acceptance case against one explicitly designated disposable
thread, on one monotonic clock:

1. Start a native `codex app-server --listen unix://<scratch>/exec-<run>.sock` in
   the fixture workdir, in its own process group. Refuse if any process already
   holds the thread's writer lock.
2. The owner connection calls `thread/resume` with no overrides. The native PID
   holding `~/.codex/thread-writer-locks/<thread>.lock` is recorded as the executor
   identity.
3. **Idle:** wait for an empty queue and `idle`, then deliver from a separate
   notifier connection with `thread/queue/add`.
4. **Busy:** the owner starts a `sleep 25` tool turn, and the notifier delivers
   while it runs. Tools are never interrupted.
5. **Disconnect:** during a `sleep 30` turn, write `queue/add` and drop the socket
   with no close handshake. Reconcile with `thread/queue/list`, replay the same
   `clientUserMessageId` once to observe dedup semantics, and delete any duplicate
   by `queuedSubmissionId`.
6. **Duplicate executor:** a second app-server attempts `thread/resume`. No input is
   sent to it.
7. **Exit:** stop the executor's process group, then attempt delivery over WebSocket
   and with `codex queue --remote`. Verify the writer lock is released, no
   replacement process exists and the rollout is unchanged.

Every consumption is judged by `sameSessionAcceptance` in `acceptance.ts`, which
uses native thread IDs, executor PIDs and `userMessage.clientId`, never reply text
alone. On failure, the driver stops every executor it spawned.

Write the target to a private file (the socket path must stay under 108 bytes):

```json
{
  "threadId": "<designated thread UUID>",
  "workdir": "/absolute/fixture/workdir",
  "rollout": "/absolute/path/rollout-…-<designated thread UUID>.jsonl",
  "priorMarker": "prior-marker-codex-alpha",
  "scratchDir": "/absolute/private/scratch",
  "outFile": "/absolute/path/live-run.json"
}
```

```sh
npm --prefix experiments/codex run live < "$TMPDIR/kha104-live-target.json"
```

The run calls the model and takes about 90 seconds. Detach it (for example with
`setsid`) if the invoking session might end first. An interrupted run can leave
queued entries, and the native queue is durable: they are consumed the next time
the thread loads. Results and findings are in
[the evidence report](../../docs/evidence/codex.md).

## Schema reproduction

```sh
codex --version
codex queue --help
codex app-server --help
codex app-server proxy --help
codex app-server generate-json-schema --experimental --out "$TMPDIR/kha104-schema"
```

[evidence/inventory.json](evidence/inventory.json) records exact commands, generated
schema hashes and sanitized output hashes. Selected full generated schema files
are retained under `evidence/schema/`; the aggregate `ClientRequest.json` is hashed
but omitted to avoid duplicating its definitions. Help is discovery evidence only.
