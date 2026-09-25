# Claude existing-session attachment probe (KHA-103)

A bounded experiment that asks whether an **already existing** Claude Code session can arrange its own
notification from a Khala channel link, consume a released message while idle and while busy, and keep its
identity and context. Results and the route decision live in [`docs/evidence/claude.md`](../../docs/evidence/claude.md).

This is an isolated npm package. It does not touch root manifests and needs no root install.

```sh
npm --prefix experiments/claude ci
npm --prefix experiments/claude test        # offline: scripted session, redaction, deadlines
npm --prefix experiments/claude run typecheck
npm --prefix experiments/claude run probe -- --help
npm --prefix experiments/claude run probe -- --inventory   # only `claude --version` and `claude --help`
```

## Live cases

Only the designated disposable session and workdir in `DESIGNATED_TARGETS` (`probe.ts`) are accepted, by both
the probe and `--seed`; add a pair there only with the owner's explicit consent. The probe never scans or
opens other sessions; it reads only `~/.claude/projects/<workdir>/<session-id>.jsonl` for the named ID.

```sh
cd experiments/claude
# once: give the session a private context marker in its own earlier turn
npm run probe -- --seed --session-id <uuid> --workdir <abs-path>
# each case resumes the same session, lets the agent set up its watch, releases one message, exits
for mode in idle busy disconnect; do
  npm run probe -- --session-id <uuid> --workdir <abs-path> --nonce release-nonce-7-$mode --mode $mode --deadline-ms 180000
done
```

Set `KHALA_CLAUDE_BIN` to use a different `claude` binary. Each run writes a sanitized `report.json` and
the raw, unpublished `events.jsonl` stream log under `runs/` (gitignored); the report carries the log's
SHA-256. Published reports are copied to `evidence/`.

## What a run does

1. Snapshots the designated transcript: session IDs, cwd, permission mode, model, sibling transcript count.
2. Resumes the session **under its own ID** through the pinned Agent SDK (`resume`), and fails the run
   if the stream reports any other session ID or working directory.
3. Sends the owner-link prompt; the agent itself starts a `Monitor` watch on the connector feed. The
   probe's `canUseTool` stands in for the owner's permission dialog and records each approval as a
   **human** setup action.
4. Writes one released message to the feed (after starting a 20 s foreground tool call in `busy` mode;
   killing the watch right after the write in `disconnect` mode, then releasing a second message).
5. Waits for the nonce and the prior marker in assistant text, then reads the transcript's native
   queue log (`enqueue` / `dequeue` / `remove`) to separate queue acceptance from consumption.
6. Closes the input, aborts if the live watch keeps the process up, writes a post-exit message, and
   checks that no process or conversation turn continued and no new transcript appeared.
