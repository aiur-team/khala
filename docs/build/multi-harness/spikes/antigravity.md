# Spike U28 (MH-U28, #1115): Antigravity CLI contract

Run 2026-10-05 by the Executor on Linux (Arch, kernel 7.1.4). This is plan unit U28 of
`docs/plans/2026-10-05-001-feat-multi-harness-parity-plan.md` (plan commit `6e573947`).

- **Antigravity CLI:** `agy` at `~/.local/bin/agy`. `agy --version` printed `1.2.13` at the start. The built-in auto-updater replaced the binary with **`1.2.17`** at 21:37:18, during the first isolated `agy models` call, before any experiment ran. The TUI banner and `ANTIGRAVITY_LS_VERSION=cli-1.2.17` confirm that every result below is from **1.2.17**.
- **Account:** already signed in (`~/.gemini/settings.json` → `"selectedType": "oauth-personal"`, Google AI Plus tier). The authenticated criteria were run, not skipped.
- **Model:** `gemini-3.8-flash-low`, the cheapest model on the list. There were 7 prompts in total, plus 2 outside wake messages.
- **Isolation:** every run used `HOME=/tmp/claude-1000/spike-1115/home`. `agy` has no config-dir flag or env var, and everything lives under `~/.gemini/`. Only `oauth_creds.json`, `google_accounts.json`, `settings.json` and `installation_id` were copied in, and that copy was deleted after the run. The real `~/.gemini/` was only read. The sha256 of all 8 real config files (`~/.gemini/*.json`, `config/mcp_config.json`, `antigravity-cli/settings.json`) matched before and after.
- **TUI:** ran in a private detached tmux server (`tmux -L spike-1115`, 200x50), driven only by `send-keys`, then killed. No GUI was touched.
- **Scripts:** `experiments/antigravity-spike/` holds the logging hook (`khala-hook.mjs`), the `hooks.json` and `mcp_config.json` used, and the MCP env/traffic logger (`mcp-envlog.sh`).
- **Fixtures for U29:** `docs/build/multi-harness/spikes/antigravity-fixtures/`. There are 9 hook payloads (stdin, stdout, hook env and cwd for each) and the client-to-server MCP traffic.

## Results

| # | Criterion | Result |
|---|---|---|
| 1 | Config file path and MCP schema, with a working `khala mcp` entry | **PASS**. The path is `~/.gemini/config/mcp_config.json` (`{"mcpServers": {name: {command, args, env, cwd, disabled, …}}}`). `agy mcp add khala khala mcp` wrote the entry. The model listed all 5 khala tools, and a TUI turn called `khala_status` and got `{"state":"idle","unread":0,"listeningMode":"sync"}` back |
| 2 | Hook events, stdin JSON and output schema, captured with a logging hook, for after-tool context and an end-of-turn continue | **PASS**. All 5 documented events fired (`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`). End-of-turn continue: `Stop` → `{"decision":"continue","reason":…}` re-entered the loop, and the model acted on the reason. After-tool context: `PreInvocation` → `injectSteps:[{ephemeralMessage}]` on the invocation after a tool result was written into the trajectory as an `EPHEMERAL_MESSAGE` step. Details below |
| 3 | The session id seen by hooks and by the MCP child | **PASS**. Hooks get the stdin `conversationId` and the env `ANTIGRAVITY_CONVERSATION_ID`. The MCP child gets **no** id in its env, but every `tools/call` carries `params._meta["antigravity.google/conversation_id"]`, and that value equals the hook `conversationId` |
| 4 | Any documented outside wake or IPC | **Recorded: YES, a native wake exists, but it needs a credential.** `agentapi send-message <conversationId> <text>` (documented for sidecars) started a turn in an **idle** TUI session twice. It typed nothing into the terminal, and a half-typed user draft survived. It needs the session's `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`. On the CLI, only the agent's own shell commands receive those: hooks and MCP children do not, and sidecars are not started by the CLI. See C4 |
| 5 | Windows support | **Recorded (docs only; no Windows machine here)**. Native Windows is supported (PowerShell and CMD installers, binary at `%LOCALAPPDATA%\agy\bin`), and config uses the same `~/.gemini/` layout. The remote-control daemon registers as a Scheduled Task. The docs do not say which shell runs a hook `command` on Windows |

The spike passes: items 1 and 3 are captured. Items 2, 4 and 5 are recorded.

**Idle input line for U38** (U38 had not recorded Antigravity): the idle prompt is a line holding only `>` (ANSI `ESC[94m>ESC[39m`). It sits between two full-width `─` (U+2500) rules, and the status line under it reads `? for shortcuts`. While a permission prompt is open, the status line reads `esc to cancel` instead.

## Evidence

### C1: MCP config and a working `khala mcp` entry

`agy mcp add --help` documents `agy mcp add [flags] <name> <commandOrUrl> [args...]` (`--env`, `--header`, `--type stdio|http`). The docs (https://antigravity.google/docs/mcp/) give two scopes: user `~/.gemini/config/mcp_config.json` and workspace `.agents/mcp_config.json`. The per-server fields are `command` | `serverUrl`, `args`, `env`, `cwd`, `headers`, `authProviderType`, `oauth`, `disabled` and `disabledTools`. The changelog embedded in the binary says the file accepts `//` and `/* */` comments and trailing commas, so an installer merge must parse JSONC.

```
$ HOME=$ISO agy mcp add khala khala mcp
Added MCP server "khala" (stdio)
$ HOME=$ISO agy mcp list
NAME      TYPE   STATUS   COMMAND/URL
khala     stdio  enabled  khala mcp
khalaenv  stdio  enabled  /bin/sh /tmp/claude-1000/spike-1115/mcp-envlog.sh
$ cat $ISO/.gemini/config/mcp_config.json
{ "mcpServers": { "khala": { "args": ["mcp"], "command": "khala", "disabled": false }, … } }
```

Print-mode run (`agy --model gemini-3.8-flash-low --output-format json --dangerously-skip-permissions -p "…"`):

```json
{"conversation_id":"a96960d4-…","status":"SUCCESS","response":"The tools provided by the `khala` and `khalaenv` MCP servers are: khala_join, khala_status, khala_read, khala_send, khala_event …"}
```

In the TUI, the model ran `Read(~/.gemini/antigravity-cli/mcp/khalaenv/khala_status.json)` (agy writes each MCP tool's schema to that file), then `khalaenv/khala_status({})`. That surfaced agy's own MCP permission prompt (`Yes, allow` / `always allow in this conversation` / `Persist to settings.json` / `No…`). Once approved, the tool returned the khala status.

MCP handshake as seen by the server (`mcp.client-to-server.json`):
1. `server/discover` (protocol `2026-07-28` `_meta`). `khala mcp` answered `-32601 Method not found`, and agy fell back to the next step without a problem.
2. `initialize`, with `clientInfo {"name":"antigravity-client","version":"v1.0.0"}`, `protocolVersion "2025-11-25"`, and capabilities `elicitation{form,url}` and `roots{listChanged}`.
3. `notifications/initialized`, then `tools/list`, then repeated `notifications/roots/list_changed`.

**The MCP child is started once per `agy` process**, when the TUI launches and before any conversation exists. Its cwd is the workspace. Its env has no `ANTIGRAVITY_*` variables at all (230 vars checked).

### C2: hook contract (logging hook)

Config: `~/.gemini/config/hooks.json`. The docs also list `.agents/hooks.json` (workspace), `~/.gemini/antigravity-cli/settings.json` and plugin `hooks.json`, and `/hooks` in the TUI lists them. The CLI logged `hooks_manager.go:53] loaded 1 named hooks from 1 hooks.json file(s)`. The schema is an object of **named hooks**. `PreToolUse` and `PostToolUse` take `[{matcher, hooks:[{type:"command", command, timeout}]}]`. `PreInvocation`, `PostInvocation` and `Stop` take a **flat** handler list, and matchers are ignored for them. `timeout` is in seconds (default 30). An optional `"enabled": false` disables a hook. See `experiments/antigravity-spike/hooks.json`.

Common stdin fields: `conversationId`, `workspacePaths`, `transcriptPath` (…`/brain/<id>/.system_generated/logs/transcript_full.jsonl` on 1.2.17; the docs say `transcript.jsonl`, and both files exist), `artifactDirectoryPath` and `modelName`. Hook process facts:
- cwd = **the directory of the hooks.json file** (`~/.gemini/config`), not the workspace.
- `ANTIGRAVITY_CONVERSATION_ID` is set in the env. `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` are **not** set.
- Hooks run synchronously, one process per event. Order within one tool turn: `PreInvocation(n)`, `PostInvocation(n)`, `PreToolUse`, `PostToolUse`, `PreInvocation(n+1)`, and so on, ending with `Stop`.

| Event | Extra stdin | Output used | Observed |
|---|---|---|---|
| `PreToolUse` | `toolCall{name,args}`, `stepIdx` | `decision` **required** (`allow`/`deny`/`ask`/`force_ask`/`deny_unless_prior_grant`), `reason`, `permissionOverrides` | Fired for `run_command`, `view_file` and `call_mcp_tool` (`args: {ServerName, ToolName, Arguments}`). Returning `allow` did **not** suppress the TUI's permission prompt for `run_command` or MCP tools |
| `PostToolUse` | `toolCall`, `stepIdx`, `error` | documented as `{}` | Fired for all three tools. There is no documented context-injection field (the proto has an undocumented `overwriteResult`, which was not tested) |
| `PreInvocation` | `invocationNum` (resets to 0 each user turn), `initialNumSteps` | `injectSteps: [{userMessage} \| {ephemeralMessage} \| {toolCall}]` | `{"ephemeralMessage":"KHALA-STEER-7F3A: …"}` on `invocationNum:1` (right after the tool result) was written as transcript step 3, `source:SYSTEM_SDK, type:EPHEMERAL_MESSAGE`, before the model's next response. The model was flash-low and did not act on the codeword, so the message was delivered but not obeyed. An injected `toolCall` failed in both shapes tried (`{name,args}`: `unknown injected step type: <nil>`; `{id,name,argumentsJson}`: protojson unmarshal error), and its schema is undocumented |
| `PostInvocation` | same as `PreInvocation` | `injectSteps`, `terminationBehavior` (`force_continue`/`terminate`/`""`) | Fired after every model call. Only the `{}` output was used |
| `Stop` | `executionNum`, `terminationReason` (`NO_TOOL_CALL` observed), `error`, `fullyIdle` | `decision` (`"continue"` re-enters the loop; anything else stops), `reason` | `{"decision":"continue","reason":"KHALA-SYNC-9C1B: … state the codeword KIWI."}` was injected as `SYSTEM_MESSAGE` "Stop hook blocked termination: …". The model then answered `KIWI`, and a second `Stop` (`executionNum:1`) got `{"decision":"stop"}` and ended the turn |

Transcript excerpt (print run `a96960d4-…`):

```
{"step_index":2,"type":"GENERIC","content":"…The command exited with code 0.\nOutput:\nkhala-probe"}
{"step_index":3,"source":"SYSTEM_SDK","type":"EPHEMERAL_MESSAGE","content":"KHALA-STEER-7F3A: a teammate says: include the codeword MANGO in your final answer."}
{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","content":"The tools provided by … khala_join, khala_status, …"}
{"step_index":5,"source":"SYSTEM","type":"SYSTEM_MESSAGE","content":"…<SYSTEM_MESSAGE>\nStop hook blocked termination: KHALA-SYNC-9C1B: … KIWI.\n</SYSTEM_MESSAGE>"}
{"step_index":6,"source":"MODEL","type":"PLANNER_RESPONSE","content":"KIWI"}
```

### C3: session id

| Seen by | Where | Value (TUI run) |
|---|---|---|
| hook | stdin `conversationId` | `875f669c-2fc9-4d22-989d-ce1395307566` |
| hook | env `ANTIGRAVITY_CONVERSATION_ID` | `875f669c-…` |
| MCP child | `tools/call` → `params._meta["antigravity.google/conversation_id"]` | `875f669c-…` |
| MCP child | `tools/call` → `params._meta["antigravity.google/artifacts_dir"]` | `…/antigravity-cli/brain/875f669c-…` (equals the hook `artifactDirectoryPath`) |
| MCP child | env | none |
| agent shell (`run_command`) | env `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID` | `875f669c-…`, `99899414-…` (the trajectory id is also the prefix of the MCP `progressToken`) |
| print mode | `--output-format json` → `conversation_id` | `a96960d4-…` |

The MCP child is shared by every conversation in one `agy` process, so the khala MCP server must key its per-call state by `_meta["antigravity.google/conversation_id"]`, not by process.

### C4: outside wake and IPC

Documented surfaces:
- **Sidecars + `agentapi`** (https://antigravity.google/docs/sidecars/). Sidecars live in `~/.gemini/config/sidecars/<id>/sidecar.json`, are enabled in `~/.gemini/config/config.json`, and get `agentapi` on their PATH. `agentapi send-message <conversation_id> <prompt>` is documented as "Sends a message to an existing conversation". In agy 1.2.17 the binary answers it as `agy agentapi …` (`get-conversation-metadata`, `new-conversation`, `send-message [--title=] <recipient_id> <content>`).
- **Remote Control** (`agy --remote-control`, `/remote-control`, `agy remote-control start|status|stop`; https://antigravity.google/docs/remote-control/). This is a browser-driven reverse tunnel through Google, with no documented local API, so it is not a khala path.

**Sidecars do not run in the CLI.** A sidecar configured and enabled exactly as the docs describe never started in the isolated home: there was no process, no env dump and no sidecar log line. The embedded experiment defaults in 1.2.17 explain why: `"enable-sidecars": true` under `base`, but `"subclients": {"CLI": {"enable-sidecars": null}}`. The docs' runtime path `~/.gemini/antigravity/sidecar_data/` belongs to the Antigravity 2.0 desktop app.

**`agentapi send-message` wakes an idle CLI session.** The agent's own shell environment (captured by having the agent run `env | grep ^ANTIGRAVITY`) holds `ANTIGRAVITY_LS_ADDRESS=localhost:33343`, `ANTIGRAVITY_CSRF_TOKEN=<36 chars>`, `ANTIGRAVITY_AGENTAPI_EXE=/home/everdred/.local/bin/agy`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID`, `ANTIGRAVITY_PROJECT_ID=default-cli-project` and `ANTIGRAVITY_APP_DATA_DIR`. The builtin `plugin` skill documents those variables ("The address and CSRF token are normally already in your shell environment"). With them set, from an unrelated shell outside agy:

```
$ agy agentapi send-message --title=khala 875f669c-… "KHALA-WAKE-3D2E: … Reply with the single word PAPAYA."
{"response":{"sendMessage":{"recipientId":"875f669c-…","content":"KHALA-WAKE-3D2E: …"}}}
# ~15 s later the idle TUI pane shows a new assistant line:   PAPAYA
# transcript: {"source":"SYSTEM","type":"SYSTEM_MESSAGE","content":"…[Message] timestamp=… sender=system priority=MESSAGE_PRIORITY_HIGH content=KHALA-WAKE-3D2E: …"}
#             {"source":"MODEL","type":"PLANNER_RESPONSE","content":"PAPAYA"}
```

- `PreInvocation`, `PostInvocation` and `Stop` hooks all fired for the woken turn, so the hook path delivers on wake turns too.
- **Draft test:** `user draft not sent` was typed into the prompt without Enter, then a second `send-message` ("… reply GUAVA") was sent. The turn ran, `GUAVA` appeared, and the prompt still read `> user draft not sent`. No keystrokes and no focus change were involved, so the KTD19 empty-prompt guard is not needed for this rung.
- **Without the token:** `healthz` on the HTTP port is open (`{"instanceId":…,"status":"ok"}`), but every RPC returns `Unauthenticated desc = missing CSRF token`. The other listening port speaks HTTPS/gRPC only.
- **Where the token lives:** only in `agy`'s memory and in the env of the agent's `run_command` children. It is not on disk anywhere under `~/.gemini`, not in `/proc/<agy>/environ`, not in hook env and not in MCP child env. It changes on every `agy` start, because the LS port is random.

So a native, KD1-clean delivery mechanism exists. What is still open is how khala gets the per-process LS address and CSRF token without a model action. Two avenues were tried or noted:
1. A `PreInvocation` hook injecting a `toolCall` step that runs `khala` in the agent shell. Two guessed shapes were rejected (see C2), and the schema is undocumented. Even with a working shape, the run would likely hit agy's normal `run_command` permission prompt unless it is allow-listed.
2. The khala join flow asks the agent to run one `khala` command in its shell, once per `agy` process. This depends on the model, but it is a single visible tool call that the user approves.

### C5: Windows

From https://antigravity.google/docs/cli/install/ and /docs/remote-control/:
- Native install: `irm https://antigravity.google/cli/install.ps1 | iex` (PowerShell) or the `install.cmd` route (CMD). The binary goes to `C:\Users\<user>\AppData\Local\agy\bin`.
- Settings live in `~/.gemini/antigravity-cli/settings.json` "across platforms", so `mcp_config.json` and `hooks.json` keep the same `~/.gemini/config/` layout.
- Remote Control daemon: Windows Scheduled Task (boot start needs Administrator).
- The 1.2.17 embedded config has Windows overrides for `enable-pty` and `enable-persistent-terminals`.
- Not covered by the docs: which shell runs a hook `command` string on Windows, and whether `agy agentapi` works there. Nothing was run on Windows.

## Consequences for dependent units

**U29 (Antigravity adapter, #1151).** The hooks are usable, so this is not the "no usable hooks" branch, and there is **no R1 hard blocker**.
- Registry: harness id `antigravity`. The MCP install is `agy mcp add khala khala mcp`, or a JSONC-tolerant merge into `~/.gemini/config/mcp_config.json`. Uninstall is `agy mcp remove khala`.
- Hooks: add a named hook `"khala"` to `~/.gemini/config/hooks.json`, and remove only that key on uninstall.
  - **This file and `mcp_config.json` are shared with the Antigravity 2.0 desktop app and the IDE** (the docs give `~/.gemini/config/` as global for all three). Installing for the CLI therefore also installs for those surfaces. U29 must accept this (the payload `artifactDirectoryPath` tells them apart: `antigravity-cli` / `antigravity` / `antigravity-ide`) or say so in the install text.
  - Hook cwd is `~/.gemini/config`, so commands must use absolute paths.
- **Codec:** do not reuse the Gemini CLI event names. The Antigravity contract is its own: `PreToolUse`/`PostToolUse`/`PreInvocation`/`PostInvocation`/`Stop`, camelCase fields, `conversationId`.
  - **Steer** (after-tool context): `PreInvocation` with `invocationNum > 0` returns `{"injectSteps":[{"ephemeralMessage": …}]}`. `userMessage` is the documented stronger alternative if U36 shows models ignore ephemeral messages; flash-low ignored one here. `PostToolUse` has no documented injection.
  - **Sync** (end-of-turn continue): `Stop` returns `{"decision":"continue","reason": …}`, which was proven. Any other `decision` value allows the stop.
  - Do **not** register `PreToolUse`: its `decision` field is required and every value changes permission behaviour.
- **Session id:** hooks use stdin `conversationId`. The MCP server reads `params._meta["antigravity.google/conversation_id"]` on each `tools/call`, because one MCP child serves every conversation of an `agy` process.
- **Wake:** the plan's default (terminal rung via U38, consent at install) stands. U28 found a **native candidate rung**, `agy agentapi send-message`: KD1-clean, draft-safe, and needing no empty-prompt guard. Its credential acquisition is unresolved, so U29 should implement it only behind a capability that is proven when the LS address and token are available, and keep the terminal rung as the fallback. Per KTD18, the credential problem is a follow-up for the U41/U38 no-gap work, not an accepted gap.
- **Fixtures:** copy `docs/build/multi-harness/spikes/antigravity-fixtures/hook.*.json` into `packages/agent/src/harness/fixtures/antigravity/`. Each file holds the exact `stdin` and the `stdout` the CLI accepted.

**U38 (terminal hosts, #1118).** Antigravity's empty-prompt pattern is the bare `>` line between two `─` rules with `? for shortcuts` below (see the Results section). The native `agentapi` rung, if U29 lands it, removes Antigravity from HB1 in every terminal, because it does not use the terminal at all.

**U36 (live matrix).** Every wake turn and every `Stop` continue is a billed model turn (`Google AI Plus` tier). The install consent text should say so (KTD8). The auto-updater silently replaced the shared `~/.local/bin/agy` binary (1.2.13 → 1.2.17) during this spike, so the matrix should record the exact `agy --version` used.

## Hard blockers

None from this spike. R1 Steer and Sync have hook mechanisms. R2 keeps the plan's terminal rung (and HB1 where U38 cannot clear it), plus a new native candidate whose credential path is an open follow-up, as described above.
