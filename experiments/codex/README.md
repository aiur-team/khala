# Existing-session attachment experiment

**Status: partial implementation; live proof blocked, no supported route claimed.**
This isolated package inventories Codex 0.154.0 and provides a bounded, explicit-target
proxy probe. It is not a production adapter. See [the evidence report](../../docs/evidence/codex.md).

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

## Remaining live-fixture protocol

These are acceptance gates, **not completed scenarios**:

1. The agent creates or is given an authorized disposable working session with
   `prior-marker-codex-alpha` already in context. Record its native UUID, executor
   process generation, workdir, model and effective permissions independently.
   Fixture creation happens before attachment; never count a resumed/new executor
   as preservation of the original working session.
2. Idle: release `release-nonce-7`, observe native queue receipt, then the model's
   response containing nonce and prior marker. Correlate native events, not merely
   generated text. Capture settings before/after.
3. Busy: repeat with a controllable long tool and record tool start/end, notification
   write, queue acceptance and first consumption using one monotonic clock or
   explicitly separate per-process clocks. Do not interrupt tools.
4. Disconnect after write/before response. Observe acceptance separately; do not
   replay until dedup/reconcile semantics have independent evidence.
5. Duplicate/new-executor negative control: reject copied history under another
   executor, including reuse of the same stored UUID. Exit the original fixture;
   attempt attachment and verify no replacement process is created.

The remaining consumption/permission/process observers and fault-injection driver
must be implemented against that real fixture. Fake transport tests are not these
runtime scenarios. No human connector installation or permission broadening is an
acceptable way to turn a failed gate into a pass.

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
