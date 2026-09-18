# Codex native queue experiment

This package records and checks the KHA-146 live proof for `codex-cli 0.154.0`.
The designated target was a disposable thread created under an isolated
`CODEX_HOME`, then resumed in the interactive Codex TUI. The native
`codex queue` command reached that TUI while it held the thread, including while
a turn was active.

The result is deliberately narrower than native payload delivery. `--message -`
and `--message @-` queue those literal strings; neither reads stdin. Released
bytes therefore cannot use this CLI without appearing in the process argument
list. Route A is suitable only for a payload-free notification. The KHA-104
app-server route remains route B for bytes.

## Validate the retained evidence

From the repository root, with Node 22.23.2 or 24.18.0:

```sh
npm --prefix experiments/codex-native ci
npm --prefix experiments/codex-native run typecheck
npm --prefix experiments/codex-native test
npm --prefix experiments/codex-native run verify:evidence
```

The verifier derives the recommendation from the recorded observations. Tests
also mutate the report to ensure a missing TUI, busy-ordering, duplicate, or
error-safety observation fails closed.

## Live procedure

Use a fresh private directory under `$TMPDIR` for both the isolated Codex home
and the fixture workdir. Copy only `auth.json` into that Codex home; never print
or retain it. Create a persisted disposable thread with the initial prompt on
stdin, record its UUID, and confirm the ordinary daemon control socket is absent.

Queue one synthetic marker while the thread is dormant, then resume that exact
UUID in the interactive TUI. The marker must appear as a user turn and the reply
must recall a prior marker that was absent from the queued text. While the TUI is
open, run the idle, sentinel, duplicate, and busy cases. Read the target rollout
only after each case to confirm the user-message text and ordering. Do not retain
the raw rollout: it includes session instructions unrelated to the proof.

The stdin checks pipe unique synthetic text into these exact shapes:

```sh
printf '%s\n' '<synthetic>' | codex queue --thread <uuid> --message -
printf '%s\n' '<synthetic>' | codex queue --thread <uuid> --message @-
```

For the busy case, start a turn in the TUI, queue during the visible `Working`
state, and compare the receipt UUID's v7 timestamp with the source turn's
completion and the queued turn's consumption timestamps. For the kill boundary,
spawn one queue process, send `SIGKILL` after 10 ms, and inspect the rollout once;
never retry the same delivery after an ambiguous result.

Only synthetic text may be passed to `--message`. Real released content is
forbidden in arguments, environment variables, errors, receipts, and retained
evidence. See [the evidence report](../../docs/evidence/codex-native-cli.md) for
the exact observations and limitations.
