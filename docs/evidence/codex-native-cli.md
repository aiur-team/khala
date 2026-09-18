# Codex native CLI queue

**Recommendation: use route A for a payload-free notification and keep route B
for bytes.** On Linux x64 with `codex-cli 0.154.0`, `codex queue --thread
<uuid> --message <text>` reached a disposable thread already open in the
interactive Codex TUI. It also persisted a message for a dormant thread and
queued behind an active turn. However, neither `--message -` nor `--message @-`
reads stdin. They deliver the literal strings `-` and `@-`. Real released bytes
would therefore appear in `argv`, which violates the product boundary.

This amends [the KHA-104 evidence](codex.md). KHA-104 route B remains valid:
Khala starts an app-server, resumes a dormant thread, and sends bytes with
`thread/queue/add`. This proof adds a native notification route into a TUI that
Khala did not start; it does not retract or replace the hosted route.

## Fixture and method

The run on 2026-09-18 used disposable thread
`01a0b66b-ce0c-7ee3-823e-14ecdb9f2856` in an isolated `CODEX_HOME` and private
workdir under the ticket's `$TMPDIR`. The thread was created with `codex exec`,
which recorded prior marker `kha146-prior-alpha`, then resumed with the
interactive `codex resume` TUI. The TUI created the thread's writer-lock file and
remained open throughout the live-owner, stdin, duplicate, and busy cases.

Raw TUI scrollback and the rollout were inspected during the run but are not
retained because they contain session instructions outside this proof. The
sanitized observations are
[live-run.json](../../experiments/codex-native/evidence/live-run.json). Its
checker and mutation tests are under
[`experiments/codex-native/`](../../experiments/codex-native/).

The queued text was synthetic. No released payload was put in an argument,
environment variable, error, receipt, or retained log. Queue calls required no
human approval. The fresh isolated fixture itself asked two setup questions:
whether to trust the workdir and whether to use the recorded session directory.

## Route table

| Route | Existing session | Bytes avoid `argv` | Busy behavior | Correlation | Verdict |
| --- | --- | --- | --- | --- | --- |
| A: `codex queue` | Reached the live TUI and recalled prior context | **No.** `-` and `@-` are literals | Accepted during an active turn and ran next | Receipt UUID is absent from the consumed user item; no client-ID flag | Notification only |
| B: Khala-hosted app-server | Proven by KHA-104 for a dormant thread Khala resumes | Yes, RPC body over the listener | `thread/queue/add` waits for the active turn | `clientUserMessageId` while queued | Payload route |

Route A can carry a non-sensitive release notification or opaque identifier if
the product chooses that behavior. It cannot carry message bytes. Route B can
carry the bytes, but it owns a resumed executor rather than attaching to the
human's already-running TUI. KHA-150 must preserve that distinction in its
capability record.

## Results

### Dormant thread and daemon lifecycle

The ordinary host check `codex app-server daemon version` failed before the run
because `~/.codex/app-server-control/app-server-control.sock` did not exist. In
the isolated fixture, the control socket was absent both before and after
`codex queue`. The command still exited 0 and returned queued-message UUID
`01a0b66c-297f-7102-b775-73f52543ad12`. It did not create a control socket.

When the exact thread was later resumed in the TUI, the queued text appeared as
a user turn and its reply recalled `kha146-prior-alpha`, which was absent from
the queued text. The native queue therefore persists independently of a running
TUI and does not require `codex queue` to start the managed daemon. The queued
entry began a model turn only when an executor loaded the thread.

### Live TUI owner

With the interactive TUI open on the target, route A exited 0 and returned
queued-message UUID `01a0b66d-03f8-7ac1-934c-d193f709e8f7`. The same TUI
rendered the queued text as its next user turn, and the reply was the prior
marker. A second app-server resume was never attempted; unlike KHA-104's route,
the CLI did not need to acquire a second writer.

This proves delivery to a TUI-owned thread for this version. It does not prove a
general attach protocol for IDEs, `codex exec`, remote-control sessions, or
other Codex releases.

### Stdin sentinels

Both candidate stdin forms exited 0, but neither consumed the piped text.

| Invocation | Queue receipt | User text observed in the TUI | Piped text observed |
| --- | --- | --- | --- |
| `printf … \| codex queue --message -` | `01a0b66d-048f-7f92-8362-bb1f8e055598` | `-` | no |
| `printf … \| codex queue --message @-` | `01a0b66d-0523-7653-ab9e-c6d19e360ffc` | `@-` | no |

The CLI help exposes only `--message <TEXT>` and no file, fd, or stdin option.
Route A cannot transport released bytes without exposing them in the process
argument list. This is the result that requires the notification-only
recommendation.

### Duplicate delivery

Two identical `kha146-duplicate-probe` submissions returned distinct queue IDs:

- `01a0b66d-05b9-7121-8be4-9e3e6d443b6f`
- `01a0b66d-0653-75e1-a224-8820c2ec0b33`

The TUI consumed two user turns and produced two replies. Native queue route A
does not deduplicate identical messages. This matches KHA-104's finding for
replayed `clientUserMessageId` values on route B: an uncertain submission must
never be retried blindly.

### Busy thread

A source turn began at `21:30:56.283Z`. While the TUI visibly reported
`Working`, route A returned queue UUID
`01a0b66e-0ac2-7851-a25e-3d0c38ec79f9`; its UUIDv7 time is
`21:31:00.162Z`. The source turn completed at `21:31:02.930Z`. The queued text
then appeared as a new user turn at `21:31:02.996Z`, 66 ms later.

The active turn was not interrupted or steered. For this version, route A has
`busy: "queue"`: acceptance is immediate, while consumption waits and starts a
new turn after the current one completes.

### Killed process and negative targets

A queue process was sent `SIGKILL` 10 ms after spawn. It emitted no receipt, and
the unique synthetic text did not appear in the rollout during the two-second
observation window. That specific early-kill run failed before the write. It
does not close the narrower write-before-receipt interval: any killed process
without a success receipt still has an `outcome_unknown` result and must not be
retried.

A nonexistent UUID exited 1 with native code `-32603` and "no rollout found".
A UUID present in the host store but absent from the isolated experiment store
failed the same way. Neither error echoed the supplied synthetic text. The
second case proves store isolation, not authorization across different users.

## Correlation and reconciliation

`codex queue --help` has no `clientUserMessageId` or release-ID option. The CLI
success line supplies a queued-message UUID, but the consumed user item contains
a different message ID and turn ID; the receipt UUID is not propagated into the
rollout. Once an entry is consumed, route A has no observed native link from its
receipt to that user item.

Content can include an opaque release identifier for notification purposes, but
that is application content rather than a queryable native correlation field.
Route A therefore reports `reconcileByReleaseId: "unsupported"`. A missing CLI
receipt never licenses a resend.

## Limits

- Only `codex-cli 0.154.0` on Linux x64 was tested.
- The target was a TUI started by this experiment under the same OS user and
  Codex account. No second credential was available, so a thread owned by a
  different OS user or account was not tested.
- The TUI command and rollout establish the target executor, but its PID could
  not be sampled from a separate sandbox PID namespace. The writer-lock file and
  same TUI consumption were observed.
- The killed-process case covered an early loss before the write. It did not
  deterministically hit the write-before-success-output interval because the
  local CLI completes too quickly.
- No IDE, remote-control, named-thread, image, or remote app-server form was
  tested.

## Reproduce the retained checks

```sh
npm --prefix experiments/codex-native ci
npm --prefix experiments/codex-native run typecheck
npm --prefix experiments/codex-native test
npm --prefix experiments/codex-native run verify:evidence
```

The final command must report
`"route": "route_a_notification_route_b_bytes"`, stdin and release-ID
reconciliation as false, and an empty `failures` array.
