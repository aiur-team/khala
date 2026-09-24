# Claude existing-session attachment proof

KHA-103 feasibility evidence. The question: can an existing Claude Code session set up its own notification from a Khala channel link, with no human infrastructure setup? It also has to consume released messages while idle and while busy, and keep its identity and context. The probe is under `experiments/claude/`. Its sanitized reports are in `experiments/claude/evidence/`.

**Conclusion: unsupported for the no-setup contract, by one permission approval.** The agent set up delivery itself, with the `Monitor` tool on a local connector feed. The same session consumed the released nonce while idle and while busy, and recalled a private marker from an earlier process. In the disconnect case, the line written just before the watch was killed was consumed because `tail` had already emitted it. The message released after the kill was **not** delivered. Session ID, working directory, model and permission mode did not change, and no replacement session appeared. In the default permission mode, though, starting the watch needs one human approval, and a pre-created allow rule would itself be human configuration. The watch also has no durability: it expires after 30 minutes, dies with the process, has no acknowledgement and does not reconnect.

Recorded 2026-09-18 on Linux 7.1.4-arch1-1 x86_64 with Node 24.18.0 and npm 11.16.0. The offline tests also pass on the repository's Node 22.23.2 pin. **Tested pair:** Claude Code 2.1.276 (native install, `~/.local/share/claude/versions/2.1.276`) with `@anthropic-ai/claude-agent-sdk` 0.3.276. This is not a minimum-version claim. TypeScript is 5.9.3 and `@types/node` 24.10.1. Isolated lock SHA-256: `7b8e25cf63092d168d2b142e8bcc8221cb93dfea58368457208992ff13af6425`. Model: `claude-opus-5` on a claude.ai subscription account. The init message reports model `claude-opus-5[1m]` and permission mode `default`.

## Target and consent

The owner designated one disposable session on #12 and authorized the cases against that session only:

- Session ID: `51b0420c-e090-4215-81f0-2d1f7073a07c`, created with `claude -p --session-id`.
- Working directory: `~/.cache/khala-disposable/claude-target`, an empty scratch directory.

The probe takes the session ID and working directory as required arguments. Both the probe and `--seed` refuse any pair not in `DESIGNATED_TARGETS` (`probe.ts`), before opening a session or creating a run directory. It reads only `~/.claude/projects/<workdir>/<id>.jsonl`, and it only counts, never opens, sibling transcripts. No other session was scanned or messaged.

**Scope limit.** Each case resumes the session in a new CLI process through the Agent SDK's `resume` option. That proves continuity of the session's identity, transcript and context. It does not prove attachment to an interactive process that is running continuously. **Unverified:** whether an interactive session behaves the same. That covers the `Monitor` tool, the queue semantics and busy delivery at a tool boundary. No interactive process was driven here. Every behaviour below was observed in SDK streaming mode (`claude` resumed by the Agent SDK) and is only a claim about that mode.

## Route table

| Route | Documented capability | Installed capability (2.1.276) | Needs from a human | Result |
| --- | --- | --- | --- | --- |
| Agent-started `Monitor` watch on a connector feed (`tail -n 0 -F <feed>`) | Built-in tool. Each output line becomes a task notification; the watch expires in 30 min unless re-armed | Present (`hasMonitor: true` in init) | One `Monitor` permission approval in `default` mode | Exercised live (SDK streaming mode). Delivers idle and busy; a message released after the watch was killed was **not** delivered; identity kept |
| Channels (MCP server pushing `notifications/claude/channel`) | [Channels reference](https://code.claude.com/docs/en/channels-reference): research preview. Registered at **startup** with `--channels` or `--dangerously-load-development-channels` (confirmation prompt; allowlist; `channelsEnabled` org policy for Team/Enterprise) | Neither flag is listed in `claude --help`: `mentions` in `evidence/inventory.json` records every help line containing `--channels`, `--dangerously-load-development-channels` or `channel`, and all three lists are empty | Restart with a flag, confirmation, org enablement | **Unsupported for no-setup attachment (AE2)**: cannot be added to an already running session. From the documentation only; no channel session was launched. This is a stated gap against the Definition of Done's "exercised" |
| Cross-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`) | [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging): on by default from v2.1.224. A session's own child processes ("a hook or Bash command") may post to its socket and are delivered unprompted when no `crossSessionInbound` value applies | Not probed | Probably none beyond the Bash approval that starts the child | **Unproven.** The line format after the optional auth line is not documented, and the plan forbids building on a reverse-engineered inbox. Worth a documented-format follow-up |
| Replacement session (new `claude -p` per message) | n/a | n/a | n/a | Out of contract: loses the working session (KD1) |

## Worked scenario

1. **Seed.** A separate earlier run gave the session `prior-marker-claude-alpha` and told it not to write the marker anywhere. It acknowledged with `MARKER-STORED` (`evidence/seed.json`; transcript snapshot in `evidence/before-seed.json`).
2. **Setup.** Each case sends the owner-link prompt. The agent calls `Monitor` on the feed itself, and the probe's `canUseTool` approves that exact command as the owner would.
3. **Release.** The probe appends one released line. The line asks for `release-nonce-7-<mode>` together with "the private context marker you were given earlier". It never contains the marker.

## Observations

Times are milliseconds on each probe process's monotonic clock. Queue rows come from transcript timestamps on the same host, mapped onto that clock.

| Case (`evidence/*.json`) | Write | Queue accepted | Left queue | Consumed + marker | Notes |
| --- | --- | --- | --- | --- | --- |
| idle | 7453 | 7654 (`enqueue`) | 7659 `dequeue` → new turn | 8558 | Turn origin `task-notification` |
| busy | 8507 (tool started 5506) | 8708 (`enqueue`, mid-tool) | 25532 `remove`, injected as `queued_command` after the tool result | 26672 | Busy tool ended at 25527 with its expected output: not interrupted, no permission widening |
| disconnect | 6823; watch killed at 6843 | 6844 | 6935 `dequeue` | 8643 (the pre-kill line, already emitted by `tail`) | Second message at 8663, after the kill: **not delivered** in 15 s |

In every case, before and after each run:

- `sessionIds` stayed `[51b0420c-…]`, `cwds` stayed `[~/.cache/khala-disposable/claude-target]`, `permissionModes` stayed `[default]` and `models` stayed `[claude-opus-5]`.
- `siblingTranscripts` was 0 before and after.
- No process referencing the session or feed survived exit.
- A message written after exit produced no conversation turn.

Raw stream logs are not published because they contain transcript content and paths. Their SHA-256 values:

| Case | Raw stream log SHA-256 |
| --- | --- |
| idle | `fd42b66f91ec4db51b1ecdbb2aa9c1a15671c08c518307242e4c372d68246131` |
| busy | `c384bde735889877fa04b40a34352a0b845985fae1e9edf0cab3f5180526e4d1` |
| disconnect | `186d4c7b54320e5635a506630aa92bdb3588e95fd6ed7f81817825c0544fb7b8` |

`claude --version` stdout hashes to `e8c1f798…` and `claude --help` stdout to `ae85d661…` (`evidence/inventory.json`). Verbatim lines backing the prose claims below are in `evidence/excerpts.json`, each tagged with its case, raw-log hash and line.

### Receipt levels (R2)

The levels are observed separately:

1. **Notification write:** the probe's append.
2. **Native queue acceptance:** a `queue-operation enqueue` in the transcript. This is not visible in the SDK stream.
3. **Delivery:** `dequeue` when idle; when busy, a `queued_command` attachment followed by `remove`.
4. **Context consumption:** assistant text containing the nonce, plus the prior marker.
5. **Task completion:** the `result` message.

A write or an enqueue alone never counted as consumption.

## Setup inventory (R3)

| Action | Actor | Evidence |
| --- | --- | --- |
| Paste owner link / setup prompt | human (ordinary chat) | setup prompt in `scenario.ts` |
| Call `Monitor` on the feed | agent | `agent-setup-tool-call` |
| Approve the `Monitor` permission prompt | **human** | `setupActions[1]`, all three reports |
| Approve the busy-case `Bash` command | none observed | `busy.json` has one `permission-request` (the `Monitor` watch); the CLI ran the `sleep` command without a prompt. Test scaffolding only, not part of attachment |
| Restart, new flag, account entitlement | none needed for `Monitor` | init shows the same session with default settings |

## Failure, duplicate and exit behaviour (U3)

- **Disconnect.** Killing the watch right after the write did not lose that line, because `tail` had already emitted it. A second message released after the kill was not delivered. Nothing reconnects the watch; the CLI reported the watch as `failed` with `exit 1` and the agent said so (`excerpts.json`, disconnect `events.jsonl#L14` and `#L16`), but only re-arming, and approving again, would restore delivery. `tail -n 0` also skips any backlog, so messages released while no watch runs are lost unless the connector replays them from a cursor.
- **Duplicate.** No replay was attempted. `Monitor` offers no acknowledgement or dedup key, so a resend could deliver twice. Exactly-once has to come from the connector: stable message IDs, and a cursor the agent passes back.
- **Exit.** Closing the SDK input did not end a process holding a live `Monitor` watch; the probe had to abort it. The CLI then enqueued the watch's own "stopped" notification without dequeuing it (`undelivered-queue-entry`). On the next resume it was the first event on the stream: `task_notification` with `status: stopped` at `events.jsonl#L1` of the busy and disconnect runs (`excerpts.json`). No replacement process or transcript was created.
- **Resume artefact.** On resume the CLI replays a zero-turn `result` before the new turn. A consumer that treats the first `result` as "turn done" ends too early. The first probe run failed this way, and the probe now waits for a result after the watch call.

## Handoff

- **KHA-106 (capability and receipt facts).** Observed with Claude 2.1.276 in SDK streaming mode only; none of this was verified in an interactive session. Four receipt levels were observable: write, native enqueue (transcript only), delivery (`dequeue`, or `queued_command` + `remove` while busy), and consumption. In the one busy run, delivery waited for the running tool to end and did not interrupt it. There is no delivery acknowledgement to the sender. KHA-106 should treat these as a tested-pair observation in streaming mode and re-verify them interactively before relying on them.
- **KHA-117 (route, schema, errors).** Recommend no route as meeting the no-setup contract. The nearest route is the agent-armed `Monitor` watch. Its smallest product gap is one permission approval per watch start. Its durability gaps, which the connector must close, are the 30-minute expiry, no reconnect, no backlog and no dedup. The follow-up worth running is the cross-session inbox with a documented message format, because own-child posts are delivered without a prompt. A failed proof here blocks the production Claude support claim; it does not relax onboarding.

## Reproduce

Follow `experiments/claude/README.md`:

```sh
npm --prefix experiments/claude ci
npm --prefix experiments/claude test
npm --prefix experiments/claude run probe -- --inventory
cd experiments/claude
npm run probe -- --seed --session-id <uuid> --workdir <abs-path>
for mode in idle busy disconnect; do
  npm run probe -- --session-id <uuid> --workdir <abs-path> --nonce release-nonce-7-$mode --mode $mode --deadline-ms 180000
done
```

The documentation for both Claude routes was checked on 2026-09-18.
