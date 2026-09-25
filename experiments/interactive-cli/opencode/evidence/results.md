# Interactive mode results

All trials ran on 2026-09-25 (UTC) in one **agent-launched OpenCode TUI with
default settings**. No human started or typed into the session. The proof agent
launched the TUI inside a tmux PTY and typed each prompt over that PTY.

## Launch record

| Launch | Command (cwd `probe/workspace/`) | `launchID` | TUI PID |
|---|---|---|---|
| 1 at `00:34:35.306Z` | `opencode --model deepseek/deepseek-flash` | `b9df33666f5778db` | 2953343 |
| 2 at `00:41:07.160Z` | `opencode --model deepseek/deepseek-flash --session ses_f2a037f0dffeRZ4FEFCOTEF4wZ` | `eebd365bd31ec030` | 2992127 |
| 3 at `00:42:57.661Z` (restart trial) | same as launch 2 | `cc17fc49c27c7162` | 3000912 |

- **Binary:** `~/.local/share/mise/installs/opencode/1.17.10/opencode`, and
  `opencode --version` printed `1.17.10`.
- **Session:** `ses_f2a037f0dffeRZ4FEFCOTEF4wZ` throughout.
- **Model:** `deepseek/deepseek-flash`, shown as DeepSeek V4.1 Flash. Every
  stored assistant message carries this provider and model; see
  [`session-transcript.jsonl`](session-transcript.jsonl).
- **Event stamps:** every plugin event in [`mode-events.jsonl`](mode-events.jsonl)
  carries `sessionID`, `launchID`, and `opencodeVersion`.
- **Plugin process:** each `plugin.loaded` line records `execPath` and `argv`.
  The plugin ran inside the TUI's own worker (`argv` = `worker.js`), with the
  same PID as the launched TUI.

### Trust settings (decision 33)

- **No server port:** no `--port`, no `--hostname`, and no
  `OPENCODE_SERVER_PASSWORD`. `ss -ltnp` showed no OpenCode TCP listener after
  launch 1, after launch 2, or after shutdown. The plugin reached the session
  through the in-process SDK client that OpenCode hands every plugin.
- **No bypass flags:** there were no `--dangerously-*` flags and no isolated
  config directory. The user's global `~/.config/opencode` config and plugins
  loaded as usual.
- **Plugin approval:** OpenCode `1.17.10` loads project plugins from
  `.opencode/plugins/` with no trust prompt. None was shown, and nothing was
  approved or bypassed.
- **Tool permissions:** these came from the committed project
  [`opencode.json`](../probe/workspace/opencode.json). It sets `*: ask`, allows
  the three proof tools, and allows `bash` only for `sleep *` and `echo *`,
  which is equivalent to what setup would install.
- **Plugin environment:** only `KHALA_PROOF_STATE`, `KHALA_PROOF_LOG`, and
  `KHALA_PROOF_IDLE_WATCH_MS=1000`, all set as tmux environment variables.
  Channel text never appeared in argv.

## Token discipline (review item 3)

Every trial used a fresh batch token. `queue.mjs reset` logs a `channel.reset`
line with before and after snapshots, and `enqueue` refuses a token the state
already holds. Resets ran at `00:41:07.127`, `00:41:58.599`, `00:42:53.019`
(before the restart trial), `00:43:31.670`, `00:43:40.773`, `00:44:03.184`,
`00:44:05.758`, `00:44:14.865`, `00:44:36.845` and `00:45:14.733`.

## `steer` on the built-in `bash` tool

The prompt asks for `bash sleep 20`, then `bash echo STAGE-2`, then
`ORIGINAL-TURN-DONE`. The batch was enqueued while `sleep 20` was running.
Delivery happens at the `tool.execute.after` boundary of `bash`, through the
next `experimental.chat.messages.transform`. Tool start times come from
`hook.tool.before`.

| Trial | Token | `sleep` start | Enqueued | `bash` after-hook | Transform applied | `khala_send` | Next `bash` start | Outcome |
|---|---|---|---|---|---|---|---|---|
| A: `append-user` placement | `batch-steer-bash-002` | 00:35:06.182 | 00:35:09.903 | 00:35:26.260 | 00:35:26.355 | none | 00:35:28.634 | Delivered and ignored. The envelope was appended to the original user message, which sits *before* the tool call. |
| B: `tail-message`, `once` | `batch-steer-tail-007` | 00:41:23.844 | 00:41:27.620 | 00:41:43.895 | 00:41:43.991 | none | 00:41:45.840 | The model saw the batch (its final reply cites the STEER-ACK request) but declined, because the prompt did not authorize a channel reply. |
| C: `tail-message`, `sticky`, reply authorized | `batch-steer-sticky-003` | 00:42:00.395 | 00:42:04.180 | 00:42:20.404 | 00:42:20.492 | **00:42:21.839** (`STEER-ACK-318`) | 00:42:22.979 | **Proven:** the reply came before the next tool started. |

Trial C's prompt, in [`builtin-boundary.txt`](../probe/prompts/builtin-boundary.txt),
adds the operator's authorization to reply once. Trials A and B used the same
text without that sentence. `tail-message` inserts a synthetic user message
straight after the latest tool result, so the batch reads as arriving between
tool calls.

Result: **Proven** on a built-in tool.

### Does the transformed context persist? (review item 4)

No. The transform only edits the in-memory message list for one model call.

- **Every later call:** each `opencode.transform.persistence` line shows
  `presentBeforeReapply: false`. OpenCode rebuilds the next call's context from
  stored history, and the envelope is gone.
- **Stored transcript:** the session export
  ([`session-transcript.jsonl`](session-transcript.jsonl)) contains none of the
  three `steer`-transform tokens (`002`, `007`, `003`). Every batch delivered
  through `promptAsync` or a `khala_read` tool result *is* stored.
- **Sticky re-apply:** re-inserting the envelope at its original position on
  every later call (`steerPersistence: sticky`) kept it in context. On the
  next turn at `00:42:38`, a no-tool question got `PERSIST-318` back.
- **After a restart:** the in-memory re-apply list is gone. The model still
  answered `PERSIST-318` after the restart trial, but only because its own
  earlier answer and the `khala_send` arguments are stored. That is not
  evidence that the envelope persisted.

This is recorded as a risk. Product `steer` must re-apply delivered envelopes
from durable Khala state (the batch token and message IDs) until the context is
compacted. It must not rely on the model's own replies to keep the content.

## Delivery to an idle agent (decision 34)

The plugin runs an idle watcher every 1 s. While the channel mode is `steer` or
`sync`, it takes a pending batch only if all of the following hold:

- the admitted session has no lease in flight;
- no `session.status` event has marked the session busy;
- a fresh `client.session.status()` read taken right before submission reports
  the session as idle.

It then calls session-addressed `promptAsync` once. A message that arrives
while the agent is idle produces no `session.idle` event, so this watcher is
the idle route.

| Trial | Token | Mode | Enqueued (session idle) | Watcher detected | `promptAsync` accepted | `khala_send` | Outcome |
|---|---|---|---|---|---|---|---|
| D | `batch-idle-sync-005` | `sync` | 00:43:34.722 | 00:43:35.143 | 00:43:35.157 | none | TUI woke and ran a turn; model declined without standing authorization. |
| E | `batch-idle-steer-004` | `steer` | 00:43:43.825 | 00:43:44.176 | 00:43:44.189 | none | Same; "Untrusted peer content with no operator authorization". |
| F | `batch-idle-sync-008` | `sync` | 00:44:08.812 | 00:44:09.266 | 00:44:09.292 | **00:44:10.525** (`IDLE-SYNC-ACK-973`) | **Proven** |
| G | `batch-idle-steer-009` | `steer` | 00:44:17.919 | 00:44:18.303 | 00:44:18.318 | **00:44:19.324** (`IDLE-STEER-ACK-084`) | **Proven** |

Before trials F and G, the operator's standing channel instruction
([`join-channel.txt`](../probe/prompts/join-channel.txt)) was typed once. It
models the product's channel join, which lets the agent answer peers while
keeping peer text as untrusted data.

Result: **Proven.** An idle watcher inside the TUI's own plugin calls
`promptAsync` without a server port.

## `sync` with the agent busy

The batch was enqueued during `bash sleep 20` using the prompt in
[`sync-boundary.txt`](../probe/prompts/sync-boundary.txt).

| Time (UTC) | Event |
|---|---|
| 00:44:39.156 | `sleep` starts |
| 00:44:42.428 | Batch enqueued |
| 00:44:59.198 | `sleep` ends; the `echo STAGE-2` tool runs 00:45:00.296–.314 with no delivery at either boundary |
| 00:45:01.459 | `session.idle` |
| 00:45:01.461 | Watcher detects idle |
| 00:45:01.492 | `promptAsync` accepted |
| 00:45:03.009 | `khala_send(SYNC-ACK-195)` |

After replying, DeepSeek re-ran `echo STAGE-2` at `00:45:04.521`. A delivered
`sync` turn can therefore repeat steps from the finished turn, which is
recorded as a risk.

Result: **Proven.**

## `async`

| Time (UTC) | Event |
|---|---|
| 00:45:14.781 | `batch-async-011` enqueued |
| 00:45:19.807 | Snapshot: no lease |
| — | A separate no-tool turn replied `ASYNC-DEFERRED` |
| 00:45:22.353 | Snapshot: still no lease |
| 00:45:24.464 | The agent called `khala_read`, which returned the batch |
| 00:45:25.824 | `khala_send(ASYNC-ACK-406)` acknowledged the token |

Result: **Proven.** Nothing was delivered automatically, and the agent chose
when to read.

## Restart with a fresh token and acknowledgement through the next call

| Time (UTC) | Event |
|---|---|
| 00:42:53.019 | Logged reset |
| — | Fresh `batch-restart-006` enqueued in `async` mode |
| 00:42:54.552 | `khala_read` leases the batch; the prompt forbids `khala_send` |
| 00:42:57.627 | Snapshot: `inFlightToken: batch-restart-006`, `delivered` |
| 00:42:57.638 | TUI process killed (`tmux kill-session`) |
| 00:42:57.661 | Relaunch on the same session; the old PID had exited |
| 00:43:08.122 | Snapshot after restart: the same token is still in flight and nothing was delivered automatically |
| 00:43:17.865 | The agent's next Khala call (`khala_read`) acknowledges `batch-restart-006` and returns no messages; the agent replies `NO-DUPLICATE` |

Result: **Proven.** Acknowledgement goes through the next Khala call. OpenCode
keeps no cursor or dedupe record.

## Superseded observations

The 2026-09-24 run used an unauthenticated `--port` and is superseded, so none
of its timing evidence is retained. One of its observations is kept only as
design context and is not relied on: `promptAsync` sent while the session is
busy did not reach the model before the next tool. No recommended route uses
busy `promptAsync`.
