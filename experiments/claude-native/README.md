# Claude native agent-route proof (KHA-145)

This isolated experiment tests two candidate routes for delivering released Khala bytes to Claude Code:

- **Route A — agent child socket.** A process launched by the Claude session inherits
  `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, authenticates, and sends one user frame.
- **Route B — Khala-hosted streaming resume.** Khala owns a long-running
  `claude -p --resume ... --input-format stream-json --output-format stream-json` process and writes user
  messages to stdin. `--replay-user-messages` separates write acknowledgement from model consumption.

The durable result and route recommendation live in
[`docs/evidence/claude-native-cli.md`](../../docs/evidence/claude-native-cli.md).

## Result

The 2.1.276 live proof keeps native support fail-closed. The hosted stream accepted idle and busy messages while
alive, but did not resume after forced interruption. The child route was not exercised because this hosted target
had no session registry, messaging socket, or child token. See the durable evidence document and `evidence/live-proof.json`; do not infer support from the
presence of the probe.

## Offline validation

This package does not touch root manifests and uses Node's built-in test runner.

```sh
npm --prefix experiments/claude-native ci
npm --prefix experiments/claude-native test
npm --prefix experiments/claude-native run typecheck
npm --prefix experiments/claude-native run verify:evidence
npm --prefix experiments/claude-native run probe -- --help
npm --prefix experiments/claude-native run probe -- --inventory
```

The tests use a private temporary Unix socket and synthetic registries. They never open a Claude session or
read `~/.claude`. They prove the refusal boundary, exact JSONL frame bytes, registry/socket binding, process
ancestry check, wrong-session rejection, secret redaction, hosted CLI arguments, and receipt classification.

## Designated-target boundary

Live socket probing is fail-closed. Before a run, the operator must explicitly consent to one disposable target
and its exact `{ sessionId, workdir, sessionPid }` tuple must be added to `DESIGNATED_TARGETS` in `probe.ts`.
The tuple is checked before any registry file is read or socket is opened. The child then:

1. reads only `~/.claude/sessions/<sessionPid>.json`;
2. requires the registry's session ID, cwd, PID, and socket path to match the designated tuple and inherited env;
3. walks only its own `/proc` ancestry and requires the designated Claude PID to be an ancestor; and
4. sends exactly one bounded payload supplied on stdin.

No token, payload, socket response, transcript, or model text is printed. The result contains only receipt
booleans, byte counts, and SHA-256 digests. A failure after the socket write is outcome-unknown and is never
automatically retried.

The installed Claude 2.1.276 binary itself prints this injection shape in its debug strings (with the actual env
values substituted at runtime): an auth JSON line followed by a user-message JSON line. `buildSocketFrame`
reproduces those bytes exactly. This is installed-binary evidence, not a stability promise for another version.

## Live Route A command

After the target is designated, the Claude session's own agent starts the child command. The target and released
payload are supplied through stdin, never argv or the environment:

```sh
npm --prefix /absolute/path/to/khala/experiments/claude-native run probe -- --socket-child \
  < "$TMPDIR/kha145-socket-input.json"
```

The private input has this shape:

```json
{
  "target": {
    "sessionId": "00000000-0000-4000-8000-000000000000",
    "workdir": "/absolute/designated/workdir",
    "sessionPid": 1234
  },
  "payload": "Synthetic released message: reply with release-nonce-... and the prior private marker.",
  "deadlineMs": 10000
}
```

## Route B seam

`hosted.ts` pins both fresh (`--session-id`) and resume (`--resume`) CLI flags, emits one stream-json user line per payload, parses JSONL output, and
classifies four independent observations: replayed-user acknowledgement, hook event, context consumption, and
completion. It deliberately uses `--permission-prompts none`; anything that would require a prompt is denied
instead of silently widening permissions. The live proof records idle, busy, disconnect, backlog, and duplicate
behavior before this route can be recommended.

## Publication discipline

Private raw runs belong under `runs/` (gitignored). Only sanitized, reviewable evidence goes under `evidence/`.
The inventory records exact CLI/runtime versions and hashes. A live report must state what was not verified and
must recommend exactly one of: route A, route B, or neither qualifies.
