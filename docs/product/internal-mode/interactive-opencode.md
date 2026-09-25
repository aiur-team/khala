# Interactive OpenCode listening modes

Status: empirical proof on 2026-09-25 (UTC). Target: OpenCode `1.17.10` with
`deepseek/deepseek-flash`, in an agent-launched interactive TUI with default
settings: no `--port`, no server password, and no bypass flags.

## Decision

All three Khala listening modes work inside the OpenCode TUI's own process.
They need no PTY wrapper, hard abort, server port, SDK-hosted agent, or
Khala-launched agent. The OpenCode plugin is the delivery boundary:

- **`steer`, agent busy:** lease a pending batch in `tool.execute.after`. At
  that session's next `experimental.chat.messages.transform`, insert the
  canonical untrusted-data envelope as a synthetic user message directly after
  the latest tool result. Re-apply it from durable state on later model calls,
  because OpenCode never stores the transform.
- **`sync` (default), agent busy:** hold the batch until the session goes idle,
  then submit it once with the in-process SDK client's session-addressed
  `promptAsync`.
- **`steer` and `sync`, agent idle:** a plugin idle watcher wakes on a new
  batch. It re-reads `session.status` and calls the same session-addressed
  `promptAsync` (decision 34).
- **`async`:** make no automatic call. The agent calls the shared `khala_read`
  operation when it decides to check the channel.

Replies are always deliberate `khala_send` calls. Khala owns the durable bounded
batch and its stable token, and the agent's next Khala call acknowledges it. The
plugin adds no second cursor, lease, acknowledgement, or dedupe database.

This refines decision 32. The `steer` transform must use the tail placement and
the durable re-apply. The idle watcher covers the case that `session.idle`
cannot: a message that arrives while the agent already sits idle.

## Proof boundary

- **Versions:** the shell's `PATH` resolved OpenCode `1.17.10`, while
  `mise exec` resolved a Node-installed `1.15.6`. Both paths and hashes are in
  [`inventory.md`](../../../experiments/interactive-cli/opencode/inventory.md).
  The proof targets `1.17.10` and pins `@opencode-ai/plugin` `1.17.10`.
- **Launch:** the proof agent launched the TUI in a tmux PTY with
  `opencode --model deepseek/deepseek-flash`, adding `--session <id>` on
  relaunch, and typed every prompt over the PTY. A human did not start the
  session, so this is **agent-launched with default settings**, not
  user-started (decision 33).
- **No port:** there was no `--port` and no OpenCode TCP listener. The plugin
  ran inside the TUI's worker, with the same PID as the launched TUI.
- **Trust settings:** OpenCode `1.17.10` shows no trust prompt for project
  plugins, and nothing was bypassed. Tool permissions came from the committed
  project `opencode.json`, as setup would write them.
- **Per-event record:** every plugin event carries the session ID
  (`ses_f2a037f0dffeRZ4FEFCOTEF4wZ`), launch ID, and OpenCode version. The
  [launch record](../../../experiments/interactive-cli/opencode/evidence/results.md#launch-record)
  maps launch IDs to commands and PIDs.
- **Pass condition:** every trial used a fresh token after a logged reset. A
  pass required DeepSeek to call `khala_send` with the nonce the batch asked
  for. API acceptance or message storage alone did not count.

## Mode matrix

| Mode | Case | Native or fallback | Result | Evidence (UTC, 2026-09-25) |
|---|---|---|---|---|
| `steer` | Agent busy in built-in `bash sleep 20` | Native plugin hooks | **Proven** | Enqueued `00:42:04.180`; `bash` returned `00:42:20.404`; transform applied `00:42:20.492`; `khala_send(STEER-ACK-318)` `00:42:21.839`; next `bash` started `00:42:22.979`. No abort. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#steer-on-the-built-in-bash-tool) |
| `steer` | Agent idle | Native plugin idle watcher + in-process `promptAsync` | **Proven** | Enqueued `00:44:17.919`; watcher `00:44:18.303`; accepted `00:44:18.318`; `khala_send(IDLE-STEER-ACK-084)` `00:44:19.324`. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#delivery-to-an-idle-agent-decision-34) |
| `sync` (default) | Agent busy | Native `session.idle` + in-process `promptAsync` | **Proven** | Enqueued during `sleep` at `00:44:42.428`; no delivery at either tool boundary; idle `00:45:01.459`; accepted `00:45:01.492`; `khala_send(SYNC-ACK-195)` `00:45:03.009`. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#sync-with-the-agent-busy) |
| `sync` (default) | Agent idle | Native plugin idle watcher + in-process `promptAsync` | **Proven** | Enqueued `00:44:08.812`; watcher `00:44:09.266`; accepted `00:44:09.292`; `khala_send(IDLE-SYNC-ACK-973)` `00:44:10.525`. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#delivery-to-an-idle-agent-decision-34) |
| `async` | Any | Native plugin tool (or MCP facade) | **Proven** | Enqueued `00:45:14.781`; no lease through a 5 s dwell and an `ASYNC-DEFERRED` turn; `khala_read` `00:45:24.464`; `khala_send(ASYNC-ACK-406)` `00:45:25.824`. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#async) |

Restart, fresh token:

| Time (UTC) | Event |
|---|---|
| `00:42:53.019` | Logged reset |
| `00:42:54.552` | `batch-restart-006` leased |
| `00:42:57.638` | TUI killed |
| `00:42:57.661` | Relaunched on the same session |
| `00:43:08.122` | Token still in flight; nothing delivered automatically |
| `00:43:17.865` | Next `khala_read` acknowledges the token and returns no messages |

This proves there is no duplicate delivery after a restart.
[Results](../../../experiments/interactive-cli/opencode/evidence/results.md#restart-with-a-fresh-token-and-acknowledgement-through-the-next-call)

No mode requires `khala run <cli>`, so a PTY wrapper is neither the default nor
a recommended fallback.

## Native routes considered

| Surface | Finding | Product use |
|---|---|---|
| Plugin hooks (`tool.execute.before/after`, `experimental.chat.messages.transform`) | Supply the after-tool boundary and a per-model-call context edit. Appending the envelope to the original user message placed it *before* the tool call, and DeepSeek ignored it. A synthetic message after the latest tool result was read and acted on. | `steer` while busy, with tail placement and durable re-apply. |
| Plugin events (`session.status`, `session.idle`) | Report busy and idle for the bound session. `session.idle` fires only when a turn ends. | `sync` while busy. Busy tracking for the idle watcher. |
| Plugin SDK client (`session.status`, `session.promptAsync`) | Reaches the TUI's own session in-process with no TCP port. An idle `promptAsync` wakes the TUI and runs a turn. | `sync` submission; idle wake for `steer` and `sync`. |
| Built-in TUI server (`--port`) | Headless Basic auth works, but the authenticated embedded TUI exits on its own unauthenticated provider call. An unauthenticated port is forbidden (decision 33). | Not used. [Auth evidence](../../../experiments/interactive-cli/opencode/evidence/server-auth.md) |
| `tui.appendPrompt` / `submitPrompt` | Scoped to the directory and focused view, not to a session. They can submit a person's draft or hit the wrong session. | Not used. |
| Abort | Exists, but tool side effects are not rolled back. | A separate future `hard-cancel` capability only; off by default and unused. |
| MCP | Tools work for explicit pull. The client handles only logging and tool-list-change notifications. | `khala_read`/`khala_send` facade for `async`. Notifications may be content-free hints only. |
| Attach, ACP, SDK-hosted agent | Alternate clients and process surfaces. | Not product routes: the user's own TUI must be the only agent process. |
| Config reload, stdin | No durable native channel queue. | Not used. |

Exact-version source links are in
[`source-notes.md`](../../../experiments/interactive-cli/opencode/source-notes.md).

## Safety contract

- **Binding:** one human-admitted binding maps to one
  `{generation, directory, sessionID, opencodeVersion, providerID, modelID}`
  tuple.
- **Checks before automatic delivery:** before any automatic route, the plugin
  re-checks the generation, the human pause/stop controls, the mode, the exact
  session, and the version/model evidence. The idle watcher also re-reads
  `session.status` immediately before `promptAsync`.
- **Session matching:** a transform applies only when the last user message's
  `sessionID` matches the queued boundary's session. An event from another
  session never consumes or drops the batch.
- **Envelope:** canonical JSON carrying the stable batch token, message IDs,
  channel and sender metadata, and the peer bodies.
  - It labels peer content as untrusted data and never interpolates it into
    system instructions.
  - `khala_send` follows OpenCode's normal permission policy.
  - The plugin never captures transcript or tool output, and never treats
    assistant output as a channel reply.
- **Acknowledgement:** API acceptance means queued, not consumed. The next
  successful Khala call acknowledges the in-flight token. If submission is
  ambiguous, preserve the token and reconcile; never replay blindly.
- **Secrets:** no channel body or credential appears in process argv or logs.
  Runtime state is owner-only.
- **Hard abort:** stays off.

## Risks and limits

| Risk | Treatment |
|---|---|
| The `steer` transform is not stored. Every later model call rebuilt context without it (`presentBeforeReapply: false`), and the session export contains none of the three transform tokens. | Re-apply each delivered-but-live envelope at its anchor on every later call, from durable Khala state (token and message IDs), not plugin memory. Plugin memory was lost on restart. Stop at compaction or when the channel is left. The tail-placement sticky re-apply was proven (`PERSIST-318` recalled on the next turn). |
| The envelope's untrusted-data framing makes DeepSeek refuse to reply unless the operator has authorized channel replies. Trials B, D and E delivered and were ignored. | The channel join (`/khala join` or channel creation) must record a standing operator instruction to answer peers through `khala_send`, and the plugin or skill must re-state it. Acceptance must treat "delivered but not answered" as a failure, not a pass. |
| The next Khala call acknowledges a batch the model saw but ignored (trial A's token stayed `delivered`). | Acknowledgement means "reached the model", per decision 1. The UI may show "delivered, unanswered" but must not re-deliver. |
| A `sync` turn delivered at idle can repeat steps from the finished turn. DeepSeek re-ran `echo STAGE-2` after `SYNC-ACK-195`. | The envelope says the prior turn is complete. Existing tool permissions still gate side effects. |
| `experimental.chat.messages.transform` may change between OpenCode versions. | Capability-gate the route to retained version evidence and fail closed on drift. Re-run the built-in-tool oracle before adding a version. |
| The transform hook gets no session argument. | Correlate the after-tool session with `output.messages[*].info.sessionID`. Skip a mismatch without dropping the token. |
| The idle watcher can race new user input, pause, stop, or restart. | Serialize per binding. Re-read controls and `session.status` immediately before `promptAsync`. In the product, wake on the `opencode-inbox-notifier` hint instead of polling. |
| `promptAsync` acceptance can be ambiguous. | Correlate the stored message and parts. Keep the token as `uncertain` on failure. |
| Authenticated external control of the embedded server is broken on `1.17.10`. | Stay in-process. Never fall back to an unauthenticated port or global TUI controls. |
| The live proof used one agent-launched session, not a human-started one. | The committed fixture passes a deterministic two-session and draft probe ([evidence](../../../experiments/interactive-cli/opencode/evidence/session-safety.md)). The live cross-agent run belongs to acceptance. |

## Ticket contracts

These contracts amend OpenCode bridge (#154)'s owner slugs rather than adding
parallel ones (decision 32).

- This evidence fulfils #154's `opencode-interactive-cli-proof` for an
  agent-launched, default-settings TUI.
- #154's `opencode-server-auth-proof` still retains the auth evidence, but no
  product route depends on a port.
- `opencode-listening-routes` is dropped. Its route work moves into
  `opencode-session-bridge`.
- Live runs belong to the acceptance area (decisions 10 and 11).

### `opencode-delivery-contract`

| Field | Contract |
|---|---|
| Title | Define OpenCode route evidence keys and delivery states |
| Complexity | `complexity:3` |
| Scope | Record the `1.17.10` evidence keys for five routes. Add `acknowledgement: batch_token_next_call`. Specify the delivery state machine. Until a route's evidence key matches, UI and capabilities must say idle agents receive messages only at their next turn. |
| Routes and delivery states | See the two lists after this table. |
| Files | `HarnessCapabilities` fixtures owned by `listening-mode-contract`. The OpenCode delivery-contract module and tests in the `@aiur/khala` OpenCode plugin layout. The evidence index linking `experiments/interactive-cli/opencode/`. |
| Acceptance | Capabilities list all five routes for the exact `1.17.10` evidence key and `unproven` for any other version or provider. `steer` stays `unproven` unless tail placement and durable re-apply are both declared. Idle-route absence produces the "next turn only" statement. The delivery-state vocabulary matches `mcp-inbox-batch` tokens exactly. |
| Wrong-implementation test | Declare `steer` for a version with only the append-to-user-message transform, or with re-apply from plugin memory. Capability admission must reject both. |
| Blocked by | `listening-mode-contract`, `mcp-inbox-batch`, `setup-cli-plan`. |

`opencode-delivery-contract` routes:

- `steer.busy`: after-tool transform with tail placement and durable re-apply.
- `steer.idle`: idle watcher.
- `sync.busy`: `session.idle` then `promptAsync`.
- `sync.idle`: idle watcher.
- `async`: `khala_read`.

`opencode-delivery-contract` delivery states:

- `leased`
- `delivered` (transform applied or `promptAsync` accepted)
- `uncertain`
- `acknowledged` (next Khala call)

### `opencode-session-bridge`

| Field | Contract |
|---|---|
| Title | Deliver proven OpenCode modes into the bound TUI session |
| Complexity | `complexity:4` |
| Scope | Add the OpenCode plugin module inside `@aiur/khala`, in-process with no port. It covers the binding and envelope, the three delivery routes, the `khala_read`/`khala_send` facades, serialized controls, and fail-closed drift. See the list after this table. |
| Files | The OpenCode plugin module in the `@aiur/khala` layout owned by `setup-cli-plan` (`modes`, `hooks`, `tools`, and a `composition` module holding SDK and descriptor imports), with package-local tests. Only minimal registration edits to `agent-cli` `cli/app.ts` and `mcp/server.ts`. |
| Acceptance | See the list after this table. |
| Wrong-implementation test | See the list after this table. |
| Blocked by | `opencode-delivery-contract`, `opencode-inbox-notifier`, `mcp-inbox-batch`, `listening-mode-pull`, `listening-mode-contract`, `listening-mode-dispatch`, `local-sqlite-channel-store`, `stop-control`, `setup-cli-plan`, `channel-access-cli-mcp`, `channel-access-journal`, `channel-access-inbox`. |

`opencode-session-bridge` scope:

- Event-correlated binding and the canonical envelope.
- `steer`: after-tool lease, tail-message transform, and durable re-apply of
  live envelopes.
- `sync`: `session.idle` submission.
- Idle wake on the `opencode-inbox-notifier` hint, with a `session.status`
  re-read before `promptAsync`.
- `khala_read`/`khala_send` facades over `listening-mode-pull`.
- Serialized pause and stop, and fail-closed drift. `hard-cancel` stays off.

`opencode-session-bridge` acceptance:

- A two-tool `bash` test consumes `steer` before tool 2, with no abort.
- `sync` is submitted only after the original turn's idle.
- A batch that arrives while idle is submitted once, within one notifier hint,
  for both `steer` and `sync`.
- `async` submits nothing automatically.
- A re-applied envelope is present on every later model call until
  acknowledged or compacted, including after a plugin restart.
- A mismatched session never receives or drops a batch.
- `khala_send` follows OpenCode's normal permissions.

`opencode-session-bridge` wrong-implementation test — it fails if any of
these happen:

- The envelope is appended to the original user message, or re-applied only
  from memory: the restart variant must still show the envelope.
- Busy `promptAsync` is used as `steer`.
- An idle-arriving batch waits for a user turn.
- Focusing session B while the binding names A changes B's context or draft.

### `setup-cli-opencode`

| Field | Contract |
|---|---|
| Title | Install the OpenCode plugin from `@aiur/khala` |
| Complexity | `complexity:3` |
| Scope | Extend `npx @aiur/khala setup`, `status` and `remove`. Detect the user's selected `opencode` binary and version (`PATH` can differ from `mise exec`). Register the plugin from `@aiur/khala` and write the proven tool permissions without widening others. Record the channel-join standing instruction the delivery routes rely on. Report per-route support from `opencode-delivery-contract`. Remove only Khala-owned entries. Never launch OpenCode or enable a server port. |
| Files | Setup-owned files from `setup-cli-plan`; the OpenCode setup adapter and its tests; concise user docs in `website/docs-app/`. |
| Acceptance | Setup preserves every unrelated plugin and config byte, writes no credentials or messages into argv or config, and adds no `--port`, password, or bypass flag. `status` reports the five routes for `1.17.10` and `unproven` elsewhere. `remove` restores the prior config. |
| Wrong-implementation test | Seed unrelated plugins, a global `"permission": "allow"`, and a `PATH` `1.17.10` against a `mise exec` `1.15.6`. Setup must target the selected binary, keep unrelated bytes, and never claim evidence for `1.15.6`. It must also fail if setup adds `--port` or an `OPENCODE_SERVER_PASSWORD` to make a route work. |
| Blocked by | `setup-cli-plan`, `authenticated-loopback-server`, `opencode-delivery-contract`, `opencode-session-bridge`. |

### Harness inputs for acceptance

`opencode-deepseek-claude-live-acceptance`, owned by the acceptance area and
run by `live-acceptance-runner`, consumes these inputs from this proof. No
OpenCode-owned live-acceptance ticket exists.

- The two-tool `bash sleep 20` and `echo STAGE-2` prompt.
- The channel-join standing instruction.
- The timing oracles, measured from the plugin's `hook.tool.before`, `session.idle`, and
  `khala_send` events:
  - `steer` before the next tool start;
  - `sync` after idle;
  - idle delivery within one hint;
  - `async` only after `khala_read`.
- Per-event `sessionID`, `launchID`, and version stamps, and the fresh-token
  restart trial.

Recommended order:

1. `opencode-delivery-contract`
2. `opencode-inbox-notifier` (#154)
3. `opencode-session-bridge`
4. `setup-cli-opencode`
5. `opencode-deepseek-claude-live-acceptance`

Shared dependencies land before the ticket that names them. The broken
authenticated embedded server blocks nothing.
