# Interactive OpenCode listening modes

Status: empirical proof on 2026-09-24. Target: OpenCode `1.17.10` with
`deepseek/deepseek-flash` in a user-started interactive TUI.

## Decision

All three Khala listening modes are feasible in the person's own OpenCode TUI
without a PTY wrapper, hard abort, SDK-hosted agent, or Khala-launched agent.
Use an installed OpenCode plugin as the delivery boundary:

- `steer`: lease a pending batch in `tool.execute.after`, then add its canonical
  untrusted-data envelope to the matching session's next
  `experimental.chat.messages.transform` call;
- `sync` (default): retain the batch while busy, then submit it to that session
  from `session.idle` with the plugin SDK's session-addressed `promptAsync`;
- `async`: make no automatic call and expose the shared `khala_read` operation
  as a plugin tool (and, where installed, the same MCP tool).

Replies remain deliberate `khala_send` calls. Khala owns the durable bounded
batch and stable token; the OpenCode plugin must not add a second cursor, lease,
acknowledgement, or dedupe database.

This supersedes two provisional conclusions in OpenCode bridge PR #154:
`sync` is proven on `1.17.10`, while busy `promptAsync` is not a valid `steer`
route. The non-abort plugin-transform route is the proved `steer` mechanism.

## Proof boundary

The shell's installed-version ordering differed from the ticket premise:
`PATH` resolved OpenCode `1.17.10`; `mise exec` resolved a Node-installed
`1.15.6`. Both executable paths and hashes are retained in
[`inventory.md`](../../../experiments/interactive-cli/opencode/inventory.md).
The proof explicitly selected the `1.17.10` binary and pinned
`@opencode-ai/plugin` `1.17.10` in its disposable workspace.

The TUI displayed DeepSeek V4.1 Flash. One sanitized hash identifies the same
visible session across all mode events. The user typed the synthetic prompts in
that TUI; message bytes were never launch arguments. A 12-second first tool and
4-second second tool separated next-tool delivery from turn-idle delivery. Each
pass required DeepSeek to call `khala_send` with a nonce derived from the channel
batch; API acceptance or message storage alone did not count.

## Mode matrix

| Mode | Native or fallback | Result | Recommended route | Evidence |
|---|---|---|---|---|
| `steer` | Native plugin hooks | **Proven** | On the admitted session's stage-1 `tool.execute.after`, lease the batch; at that same session's next message transform, append the canonical envelope to model context. Never abort by default. | The transform applied at `22:29:07.562Z`; `STEER-ACK-731` was sent at `22:29:08.879Z`; tool 2 began later at `22:29:10.157Z`. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#steer), [events](../../../experiments/interactive-cli/opencode/evidence/mode-events.jsonl). |
| `sync` (default) | Native plugin event + SDK client | **Proven** | Queue while busy. On `session.idle`, revalidate the exact session/control state and call session-addressed `promptAsync` once. | Tool 2 ended at `22:30:23.733Z`; idle occurred at `22:30:24.865Z`; submission followed at `22:30:24.884Z`; `SYNC-ACK-482` was sent at `22:30:26.877Z`. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#sync), [events](../../../experiments/interactive-cli/opencode/evidence/mode-events.jsonl). |
| `async` | Native plugin/MCP tool | **Proven** | Do nothing automatically. The agent invokes the one shared `khala_read` tool when it decides to check the channel. | The batch survived a five-second dwell and an `ASYNC-DEFERRED` turn; only the later `khala_read` returned it, followed by `ASYNC-ACK-964`. [Results](../../../experiments/interactive-cli/opencode/evidence/results.md#async), [events](../../../experiments/interactive-cli/opencode/evidence/mode-events.jsonl). |

No mode requires `khala run <cli>`. A PTY wrapper is therefore neither the
default nor a recommended fallback for this version.

## Native routes considered

| Surface | Finding | Product use |
|---|---|---|
| Plugin event stream and hooks | `tool.execute.after`, `session.idle`, and the experimental message transform provide the two required automatic boundaries. | Primary route. |
| Plugin SDK `session.promptAsync` | Wakes and consumes when called after idle. When called while busy, it accepted/persisted the batch but did not satisfy the before-tool-2 oracle. | `sync` only. Do not advertise busy submission as `steer`. |
| Built-in TUI server | Session reads/status/prompt/abort and TUI append/submit exist. Headless Basic auth rejects missing/wrong credentials, but the authenticated embedded TUI exits on its own unauthenticated provider call. | Diagnostic only on `1.17.10`; an unauthenticated companion is not a product route. [Auth evidence](../../../experiments/interactive-cli/opencode/evidence/server-auth.md). |
| `tui.appendPrompt` / `submitPrompt` | Directory/focus scoped rather than session addressed. They may submit a person's draft or target the wrong session. | Do not use for automatic delivery. |
| Abort | Endpoint exists, but tool side effects are not rollback. | Separate future `hard-cancel` capability only; off by default and unused here. |
| MCP | Agent-callable tools work for explicit pull. OpenCode's MCP client handles logging and tool-list-change server notifications, not arbitrary notification-to-prompt injection. | `khala_read`/`khala_send` facade for `async`; notifications may be content-free hints only. |
| Attach, ACP, SDK-hosted agent | Alternate clients/process surfaces exist. | Not product routes: the operator requires the person's own TUI to be the only agent process. |
| Config reload, stdin | No durable native channel queue was found. | Do not poll config or type synthetic channel bytes into stdin. |

Exact-version source links and local CLI output are in
[`source-notes.md`](../../../experiments/interactive-cli/opencode/source-notes.md).

## Safety contract

One human-admitted binding maps to one `{generation, directory, sessionID,
opencodeVersion, providerID, modelID}` tuple. Before either automatic route, the
plugin rechecks the generation, human pause/stop, mode, exact session, and
version/model evidence. A transform applies only when the last user message's
`sessionID` equals the queued boundary's session; an event from another session
must not consume or drop the batch.

The channel envelope is canonical JSON containing the stable batch token,
message IDs, channel/sender metadata, and deliberate peer bodies. It labels peer
content as untrusted data and preserves the TUI's existing permission policy.
It never interpolates peer text into system instructions, auto-approves a tool,
captures transcript/tool output, or treats assistant output as a channel reply.

API acceptance means queued, not consumed. The next successful Khala call
acknowledges the in-flight token. A real process-restart trial retained
`batch-async-001`; the first post-restart read acknowledged it and returned an
empty batch, proving no duplicate delivery. [Restart evidence](../../../experiments/interactive-cli/opencode/evidence/results.md#restart-and-acknowledgement).

No channel body or credential may appear in process argv or logs. Runtime
descriptors and state are owner-only. Hard abort remains off. If submission is
ambiguous, preserve the token and require reconciliation; never blind-replay.

## Risks and limits

| Risk | Treatment |
|---|---|
| `experimental.chat.messages.transform` may change across OpenCode versions. | Capability-gate the route to retained version evidence and fail closed on drift. Re-run the two-boundary oracle before adding a version. |
| The transform hook has no direct session argument. | Correlate the after-tool session with `output.messages[*].info.sessionID`; skip mismatches without dropping the queued token. |
| An idle event can race pause, stop, restart, or fresh user work. | Serialize per binding and re-read controls/session state immediately before submission. Treat the event as a hint, not authority. |
| `promptAsync` acceptance may be ambiguous. | Correlate stored message/parts and eventual model action; preserve the Khala token on uncertainty. |
| Multiple batches arrive before a boundary. | Khala returns one bounded ordered batch. Acknowledge only on the next Khala call, then expose the next batch through the shared piggyback contract. |
| Peer content can request dangerous tools or exfiltration. | Keep it untrusted, retain OpenCode's tool gates, scope `khala_send` to the admitted channel, and apply the shared outbound-approval/context-isolation policy. |
| Authenticated external control of the embedded server is broken on `1.17.10`. | Keep the bridge in-process. Do not fall back to an unauthenticated server or global TUI controls. |
| The live timing proof used one synthetic session rather than private user data. | The committed fixture passes a deterministic two-session/draft guard probe; product acceptance must repeat the canary in live TUIs. [Safety evidence](../../../experiments/interactive-cli/opencode/evidence/session-safety.md). |

## Ticket contracts

### `opencode-plugin-foundation`

| Field | Contract |
|---|---|
| Title | Install and bind the user-started OpenCode plugin |
| Complexity | `complexity:4` |
| Scope | Create `packages/opencode-plugin/` with a port-first plugin entrypoint, owner-only runtime descriptor, explicit binding generation/session tuple, exact OpenCode/provider/model evidence key, canonical channel envelope, event recorder interface, and fail-closed lifecycle. The user starts OpenCode; Khala never launches it. |
| Files | `packages/opencode-plugin/{package.json,src/**,README.md}`; workspace/export metadata; package-local tests. |
| Acceptance | A human can admit or create a channel from their already-running TUI; one binding selects only the admitted session; stale generation, unknown version/model, missing descriptor, or ambiguous session fails closed; peer bytes remain data; existing permissions and outbound policy remain intact. |
| Wrong-implementation test | Run two sessions in one project, focus session B while the binding names A, and queue an event from A. B's context and draft must remain byte-for-byte unchanged, and the batch must remain pending rather than being dropped. |
| Blocked by | `opencode-delivery-contract`, `setup-cli-plan`, `authenticated-loopback-server`, `local-sqlite-channel-store`. |

### `opencode-channel-tools`

| Field | Contract |
|---|---|
| Title | Expose deliberate OpenCode channel read and send tools |
| Complexity | `complexity:3` |
| Scope | Add plugin tool facades for the single shared `khala_read` and `khala_send` operations. `khala_read` returns the canonical bounded batch/token; any MCP exposure delegates to the same operation. `khala_send` is destination scoped and sends only explicit agent-authored bytes. |
| Files | `packages/opencode-plugin/src/tools/**`; minimal tool registration; package-local tests and docs. |
| Acceptance | `async` makes no automatic OpenCode call; read order/token/ceiling exactly match the CLI/MCP contract; a next successful Khala call acknowledges only the preceding token; neither transcript nor tool output is sent implicitly. |
| Wrong-implementation test | Queue two batches, restart after reading the first but before a send, then read again. The first token is acknowledged once, the first body is not redelivered, and the second batch is returned without any OpenCode-side cursor or dedupe record. |
| Blocked by | `opencode-plugin-foundation`, `mcp-inbox-batch`, `mcp-result-piggyback`, `listening-mode-pull`. |

### `opencode-listening-routes`

| Field | Contract |
|---|---|
| Title | Implement proven OpenCode steer and sync boundaries |
| Complexity | `complexity:4` |
| Scope | Implement the evidence-gated mode scheduler: `steer` queues at `tool.execute.after` and applies only to the matching next message transform; `sync` queues until matching `session.idle` then uses session-addressed `promptAsync`; `async` delegates to `opencode-channel-tools`. Serialize controls and submission per binding. Keep `hard-cancel` off. |
| Files | `packages/opencode-plugin/src/{modes,hooks,composition}/**`; capability fixtures; package-local integration tests. |
| Acceptance | The exact `1.17.10` evidence key advertises all three modes with `sync` default; a two-tool test proves `steer` consumption before tool 2 and `sync` consumption only after idle; pause/stop and session mismatch win races; unsupported versions visibly fail closed; no mode calls abort. |
| Wrong-implementation test | Send a `steer` batch during tool 1 and a `sync` batch during a separate tool-1 run. Fail if tool 2 starts before the `steer` batch is consumed, if `sync` is visible before the original idle event, if busy `promptAsync` is used as `steer`, or if either batch reaches a different session. |
| Blocked by | `opencode-plugin-foundation`, `opencode-channel-tools`, `listening-mode-contract`, `listening-mode-dispatch`, `stop-control`. |

### `opencode-plugin-setup`

| Field | Contract |
|---|---|
| Title | Add safe setup, status, and removal for OpenCode |
| Complexity | `complexity:3` |
| Scope | Extend the shared setup flow to detect both binary layouts, install the version-compatible plugin, create an owner-only descriptor, report effective mode support and drift, and remove only Khala-owned files. Support channel URL admission and human-confirmed channel creation from the CLI. |
| Files | Setup-owned CLI/package files from `setup-cli-plan`; OpenCode-specific adapter and tests; concise user docs. |
| Acceptance | Setup never launches OpenCode, never writes credentials/messages to argv or config, preserves unrelated plugins/config, detects the observed `PATH` versus `mise exec` discrepancy, and reports all modes unsupported on an unproved version instead of guessing. |
| Wrong-implementation test | Seed unrelated OpenCode plugins and make `PATH` resolve `1.17.10` while `mise exec` resolves `1.15.6`; install/status/remove must target the user's selected executable, preserve every unrelated byte, and never claim evidence for the other version. |
| Blocked by | `setup-cli-plan`, `opencode-plugin-foundation`, `opencode-listening-routes`. |

### `opencode-live-acceptance`

| Field | Contract |
|---|---|
| Title | Prove OpenCode and DeepSeek in a live Khala channel |
| Complexity | `complexity:4` |
| Scope | Extend the E09 acceptance driver for a human-started OpenCode TUI running DeepSeek. Cover admission/create-channel, bidirectional deliberate messages, all three modes, pause/resume/stop, restart before acknowledgement, wrong-session/draft canaries, hostile peer data, and cleanup. |
| Files | Acceptance-owned scripts under `tests/e2e/` and retained sanitized evidence/docs; no production bridge logic. |
| Acceptance | Executor logs correlate channel release IDs and batch tokens to the already-existing TUI session; each nonce is returned via `khala_send`; `steer`, `sync`, and `async` satisfy their timing oracles; no duplicate follows restart; denied tools stay denied; no transcript, secret, or draft leaks; all test resources/processes are cleaned. |
| Wrong-implementation test | Run the entire scenario with a headless `opencode serve` or SDK-created session while the human TUI remains unchanged. The acceptance driver must fail even if every nonce is returned, because only delivery into the user-started interactive session counts. |
| Blocked by | `opencode-plugin-setup`, `opencode-listening-routes`, `acceptance`, `local-sqlite-channel-store`. |

Recommended order:
`opencode-plugin-foundation` → `opencode-channel-tools` →
`opencode-listening-routes` → `opencode-plugin-setup` →
`opencode-live-acceptance`. Shared-contract dependencies land before the ticket
that names them; the authenticated built-in-server defect does not block the
in-process plugin route.
