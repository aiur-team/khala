# Spike MH-U32: Muse Code contract

- Ticket: aiur-team/khala#1117 (plan unit U32, plan commit `6e573947`).
- Run: 2026-10-05 by the Executor (Claude Code), on Linux (Arch, kernel 7.1.4).
- **Muse version: `Muse Code 1.4.3 (1.4.3-R5018.1)`** (`muse --version`). The binary was invoked directly as `~/.local/bin/muse-bin-1.4.3-R5018.1`, with `MUSE_NO_AUTO_UPDATE=1`.
- Model: `muse-spark-1.3` at `--reasoning-effort minimal`. That is 3 model prompts in total: 2 headless `muse exec` runs and 1 TUI prompt. Plugin and MCP spawn checks used `--provider echo`, which makes no model call.
- Fixtures for U33: [`muse-fixtures/`](muse-fixtures/).

## Results

| # | Criterion | Result | One-line evidence |
|---|-----------|--------|-------------------|
| 1 | A logging hook on `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop` captures stdin JSON and env | **PASS** | All four fired from user `settings.json` `hooks`. Stdin JSON carries `session_id`, `turn_id`, `cwd`, `hook_event_name` and event fields. Env is scrubbed to about 10 variables, with **no `MUSE_SESSION_ID`** |
| 2 | `PostToolUse` output can add model context | **PASS** (only via `hookSpecificOutput.additionalContext`) | `hookSpecificOutput.additionalContext` became a `developer`-role context block, and the model acted on it (`PELICAN`). Top-level `additionalContext` **failed the hook** (`unsupported \`additionalContext\` in output of PostToolUse hook output`). Plain stdout was **ignored** |
| 3 | A `Stop` hook can force a continue with `decision: 'block'` | **PASS** | Hook status `blocked`. `reason` was injected as a `developer` context block, the model took another step, and Stop fired again with `stop_hook_active: true`. Output: `…PELICAN check passed.RESUMED` |
| 4 | `MUSE_SESSION_ID` reaches `khala mcp` | **PASS** | A stdio MCP server from user `mcp_servers` got `MUSE_SESSION_ID=01a10fd4-…` (equal to the hook's `session_id`) at spawn and on every `tools/call`. A plugin-shipped MCP server got it as well |
| 5 | A process outside Muse can send a session-messaging peer message to an idle session and start a turn | **FAIL** | `muse session-message send` exists, but it returns `external_agent_ingress_closed` (an account feature gate that is off). With the undocumented `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS=1` on both ends, the receiver refused admission (`containment_limited` / `causal_metadata_invalid`). No turn started |
| 6 | A plugin manifest can ship `mcp_servers` | **PASS** | A native `.muse-plugin/plugin.json` with `capabilities.mcpServers` validated, installed and spawned the server, but **only after a one-time `muse plugins approve`**. Khala's existing Claude plugin also validates (`manifest_family` claude, `mcp:khala` supported) |
| 7 | Whether Khala's peer messages need approval, whether that is one-time, and what happens before it | **FAIL** (not determinable) | Khala-side (external) messages are refused **before** the approval stage, so there is no prompt to observe, and nothing is parked or delivered. Control: a native Muse→Muse peer message to an idle session was auto-admitted with **no prompt** (`cause: exact_profile_match`, `wake_policy: wake_when_idle`), and it started a turn |
| 8 | The settings path and the shell that runs hook commands on Windows | **UNTESTED** | There is no Windows machine. Linux results: hooks run under the user's `$SHELL -c` (zsh here, not `/bin/sh`), and settings live at `$XDG_CONFIG_HOME/muse/settings.json`, else `~/.config/muse/settings.json` |

**No KD5/KTD18 hard blocker.** Items 2 and 3 pass, so Steer and Sync exist. Item 5's FAIL takes the plan's named branch (terminal rung, with U40 pursuing a native path). Item 7 cannot be decided until Muse opens external ingress, and that question passes to U40.

## Setup (isolation)

- Isolated config, data, state and cache: `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` all pointed under `/tmp/claude-1000/s1117/home`. The operator's `~/.config/muse/auth.json` was **copied** (read only) into the isolated config dir. No real config file was written.
- **One write escaped isolation:** Muse writes the session-name registry `~/.local/share/muse/session-name-authority/session-names.db` under the real home even when `HOME` and `XDG_DATA_HOME` are overridden, so the path is probably resolved from the passwd entry. Each spike session added a name claim (for example `wool-deimos`). This is runtime state, not config. It was left in place (see Operator notes).
- Logging hook: `hook.sh <Event>` writes stdin to `<Event>-<ns>.stdin.json`, `env | sort` to `.env`, and parent and self exe to `.proc`. It then prints the next queued one-shot response from `mode/<Event>.<n>`, if one exists.
- Logging MCP server: `mcp.py` is a dependency-free NDJSON stdio server with one read-only tool `spike_ping`. It logs its env at spawn and `MUSE_SESSION_ID` on each `tools/call`.
- TUIs ran in a private tmux server, `tmux -L spike-1117 new-session -d -x 200 -y 50 …`, driven with `send-keys` and read with `capture-pane`. The server was killed afterwards.

User settings used (fixture: [`settings.after-plugins-approve.json`](muse-fixtures/settings.after-plugins-approve.json)):

```json
{
  "schema_version": 1, "provider": "meta", "model": "muse-spark-1.3",
  "mcp_servers": { "spike": { "transport": "stdio", "command": "python3", "args": ["/tmp/claude-1000/s1117/mcp.py"] } },
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "/tmp/claude-1000/s1117/hook.sh SessionStart" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "/tmp/claude-1000/s1117/hook.sh UserPromptSubmit" } ] } ],
    "PostToolUse":      [ { "matcher": "mcp__spike__.*", "hooks": [ { "type": "command", "command": "/tmp/claude-1000/s1117/hook.sh PostToolUse" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "/tmp/claude-1000/s1117/hook.sh Stop" } ] } ]
  }
}
```

The hook schema is Claude-shaped: the `{matcher?, hooks: [{type: "command", command}]}` groups were accepted unchanged.

## Evidence

### 1. Logging hooks: PASS

```
$ muse exec --json --model muse-spark-1.3 --reasoning-effort minimal --workspace $S/ws \
    "Call the spike_ping tool exactly three times, one call at a time … list every NONCE-… token …"
exit=0
logs: SessionStart ×1, UserPromptSubmit ×1, PostToolUse ×3, Stop ×2
```

Stdin JSON, verbatim (fixtures in [`muse-fixtures/hooks/`](muse-fixtures/hooks/)):

```json
{"cwd":"/tmp/claude-1000/s1117/ws","hook_event_name":"SessionStart","model":"muse-spark-1.3","model_provider":"meta","permission_mode":"default","session_id":"01a10fd4-1959-7940-80e1-db5f5189fe43","source":"startup","transcript_path":null}
{"cwd":"…","hook_event_name":"UserPromptSubmit","model":"muse-spark-1.3","model_provider":"meta","permission_mode":"default","prompt":"Call the spike_ping tool …","session_id":"01a10fd4-…","transcript_path":null,"turn_id":"d26809ba-…"}
{"cwd":"…","hook_event_name":"PostToolUse","model":"muse-spark-1.3","model_provider":"meta","permission_mode":"default","session_id":"01a10fd4-…","tool_input":{},"tool_name":"mcp__spike__spike_ping","tool_response":"pong","tool_use_id":"call_01a10fd4…","transcript_path":null,"turn_id":"d26809ba-…"}
{"cwd":"…","hook_event_name":"Stop","last_assistant_message":"All three `spike_ping` calls completed, …","model":"muse-spark-1.3","model_provider":"meta","permission_mode":"default","session_id":"01a10fd4-…","stop_hook_active":false,"transcript_path":null,"turn_id":"d26809ba-…"}
```

- `transcript_path` is always `null`. The session log path is `${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<session_id>/session.jsonl`, and Muse states it to the model in a `session-identity` system reminder.
- MCP tool names are `mcp__<server>__<tool>`. The `matcher` is a regex over `tool_name`.
- **Hook env is scrubbed** to `HOME LANG LOGNAME OLDPWD PATH PWD SHELL SHLVL TERM USER`, with no `MUSE_*` at all ([`hook-env.txt`](muse-fixtures/hooks/hook-env.txt)). Plugin hooks additionally get `MUSE_PLUGIN_ID`, `MUSE_PLUGIN_ROOT` and `MUSE_PLUGIN_DATA_DIR`. The session id for hooks comes only from stdin `session_id`.
- Shell probe ([`shell-probe.txt`](muse-fixtures/hooks/shell-probe.txt)): `dollar0=/usr/bin/zsh exe=/usr/bin/zsh ppexe=…/muse-bin-1.4.3-R5018.1 SHELL=/usr/bin/zsh`. A string hook command runs as `$SHELL -c '<command>'`, the user's login shell, not `/bin/sh`. Plugin hooks take structured argv (`["sh","hooks/log.sh"]`) instead.
- Muse records every hook run as `hook_run_started` / `hook_run_terminal {status, error, exit_code}` in `session.jsonl` ([`hook-results.run1.ndjson`](muse-fixtures/hooks/hook-results.run1.ndjson)).

### 2. `PostToolUse` context injection: PASS (one shape only)

There were three one-shot responses, one per `spike_ping` call. From `session.jsonl`:

| Hook output | `hook_run_terminal` | Context |
|---|---|---|
| `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"NONCE-HSO-6113: …maroon."}}` | `completed` | `context_block_updated {source:"runtime_hook", role:"developer", lifecycle:"post_tool_use", text:"NONCE-HSO-6113: …"}` |
| `{"additionalContext":"NONCE-TOP-2741: …ibex."}` | **`failed`**, `error: "unsupported \`additionalContext\` in output of PostToolUse hook output"` | none |
| `NONCE-STDOUT-9058: …loquat.` (plain text) | `completed` | none (stdout discarded) |

Model behaviour (run 2, Khala-style text): the hook returned `hookSpecificOutput.additionalContext` = `[khala] New message in your Khala channel from the user you are working for: "When you reply, include the word PELICAN."`. The final answer was `Spike ping returned pong — PELICAN check passed.` In run 1, the model saw the HSO nonce but declined to *repeat* it ("I can't list NONCE tokens / secrets from non-user context"). Hook context is delivered with developer authority, but the model treats it as non-user content, so Khala's injected text should be framed as a channel notice, not as a secret.

### 3. `Stop` `decision: "block"` forces a continue: PASS

- Run 1: the hook returned `{"decision":"block","reason":"NONCE-STOP-3317: before finishing, reply with the single word RESUMED."}`. The result was `hook_run_terminal {event:"Stop", status:"blocked"}`, then `context_block_updated {lifecycle:"stop", role:"developer", text:"NONCE-STOP-3317 …"}`. The model then ran one more step ("Done."), and Stop fired a second time with `"stop_hook_active": true` and `last_assistant_message: "Done."`.
- Run 2, with a Khala-style reason (`[khala] New message …: "Before you finish, also say the word RESUMED."`): the final output was `Spike ping returned pong — PELICAN check passed.RESUMED`.
- A settings key `max_consecutive_stop_hook_continuations` exists (binary strings, also enterprise policy `stop_hook_continuations.maximum`), so Muse caps Stop loops. U33 should still gate on `stop_hook_active`.

### 4. `MUSE_SESSION_ID` reaches the MCP server: PASS

```json
// muse-fixtures/mcp/user-mcp-server-env.json (spawned at session start, before any tool call)
{"argv": ["/tmp/claude-1000/s1117/mcp.py"], "env_subset": {"HOME": "…", "MUSE_SESSION_ID": "01a10fd4-1959-7940-80e1-db5f5189fe43", "SHELL": "/usr/bin/zsh"}}
// muse-fixtures/mcp/tools-call-MUSE_SESSION_ID.json: all 3 tools/call
{"params": {"arguments": {}, "name": "spike_ping"}, "MUSE_SESSION_ID": "01a10fd4-1959-7940-80e1-db5f5189fe43"}
```

`MUSE_SESSION_ID` equals the hooks' stdin `session_id`, so `env` identity works and `hook-map` is not needed for the MCP side. MCP handshake `protocolVersion` was `2025-06-18`. A new MCP process is spawned per session (`exec`), so each process sees exactly one session id.

### 5. External sender wakes an idle session: FAIL

`muse session-message` is a real CLI: `list [--json]` and `send --target <session-uuid-or-name> [--in-reply-to <reply-token>] [--display-context <json>] [--json] < body`. From a plain shell, with the receiver an idle TUI in the same isolated HOME (full log: [`external-sender.txt`](muse-fixtures/session-message/external-sender.txt)):

```
$ muse session-message list --json
{"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed"}
$ printf 'probe' | muse session-message send --target cedar-sinope --json
{"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed","receipts":[]}
```

- `external_agent_ingress` is a feature gate, listed beside `local_session_messaging` and the other server-fetched gates. The account's fetched gates (`feature-config/*.json`) contain `local_session_messaging: true` but **no `external_agent_ingress`**, so it is off.
- Diagnostic only: with the undocumented `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS=1` on the sender, `list` works and `send` resolves the target, but the receiver still answers `external_agent_ingress_closed`. With the variable on the receiver too (TUI relaunched with it, which Khala could not do under KD1), the receiver refused at `target_admission`: `containment_limited`, `containment_reason: causal_metadata_invalid`, `target_verification: unverified_kernel_peer`. The TUI stayed idle and showed no prompt. Passing `--display-context '{}'`, or `MUSE_SESSION_ID` set to another session's id or to the target's own id, made no difference.
- So in 1.4.3 there is no documented, KD1-clean way for a non-Muse process to deliver a peer message. The receiver side is gated, and on Linux the sender is classed `unverified_kernel_peer`; the binary also knows `verified_macos_cli`, which hints that macOS code-signed senders get further.

### 6. Plugin ships an MCP server: PASS

Native manifest ([`plugin/plugin.json`](muse-fixtures/plugin/plugin.json)). The manifest key is `capabilities.mcpServers`, an array of `{id, transport, command: [argv]}`:

```json
{ "schemaVersion": 1, "name": "khala-spike", "displayName": "Khala Spike", "version": "0.1.0", "description": "…",
  "compat": { "source": "native", "manifestDir": ".muse-plugin" },
  "capabilities": { "skills": [], "commands": [], "reminders": [],
    "hooks": [ { "id": "session-start-log", "event": "SessionStart", "command": ["sh", "hooks/log.sh", "SessionStart"], "timeoutMs": 5000 } ],
    "mcpServers": [ { "id": "khala-spike", "transport": "stdio", "command": ["python3", "mcp/server.py"] } ] } }
```

```
$ muse plugins validate ./khala-spike --json    -> "valid": true, "diagnostics": [], compatibility.summary "full"
$ muse plugins install ./khala-spike --scope user --json
  -> "trust": "user-local", "warning": "third-party plugin: hooks and MCP servers require review before activation"
$ muse exec --provider echo "hello"             -> plugin MCP server NOT spawned, plugin hook NOT run
$ muse plugins approve khala-spike --json
  -> runtime_capabilities: plugin:khala-spike:hook:session-start-log (enabled), plugin:khala-spike:mcp_server:khala-spike (enabled), each with trusted_definition_hash
$ muse exec --provider echo "hello"             -> plugin MCP server spawned and plugin hook ran
```

Plugin MCP env ([`plugin-mcp-server-env.json`](muse-fixtures/mcp/plugin-mcp-server-env.json)): `MUSE_SESSION_ID`, `MUSE_PLUGIN_ID=khala-spike`, `MUSE_PLUGIN_ROOT=…/plugins/cache/local/khala-spike/<sha256>/package` and `MUSE_PLUGIN_DATA_DIR`.

Side effects to plan for:
- `muse plugins approve` **rewrote the user `settings.json`**. It normalized the key `mcp_servers` to **`mcpServers`**, re-sorted keys, and added a `runtime_capabilities` map keyed by stable id with `trusted_definition_hash`.
  - So both spellings are accepted, and Muse writes camelCase. U33's installer must read both.
  - Approval is pinned to the definition hash, so a changed plugin hook or MCP definition needs re-approval.
- **Khala's existing Claude plugin** (`packages/agent/claude-plugin/khala`) validates as a Muse plugin ([`khala-claude-plugin-validate.json`](muse-fixtures/plugin/khala-claude-plugin-validate.json)).
  - `skill:khala`, five hooks and `mcp:khala` (`${CLAUDE_PLUGIN_ROOT}/bin/khala mcp --harness claude`) are `supported`.
  - The `Stop` hook with `asyncRewake: true` is **not run**: "Muse does not wake the model from a hook". Muse has no asyncRewake analogue.

### 7. Peer approval for Khala: FAIL (not determinable)

- Khala-side messages never reach admission (item 5), so whether Khala needs approval, and whether it is one-time, cannot be observed on 1.4.3. Before any approval, external messages are **refused, not parked**: `status: unavailable`, nothing is delivered and nothing appears in the TUI.
- Control, native Muse→Muse (1 TUI prompt in a second session: "send … to the peer session named wool-deimos"):
  - Sender: `◆ Sent message to wool-deimos · ✓ · delivery unconfirmed`.
  - Idle receiver: `◆ Received message from grassy-photon`. **A turn started with no approval prompt.**
  - Receiver log ([`native-peer-receiver.ndjson`](muse-fixtures/session-message/native-peer-receiver.ndjson)): `peer_message.admission.settled {cause: "exact_profile_match", … disposition: "steer", delivery_policy: "steer_active_turn", wake_policy: "wake_when_idle", ingress_provenance: "muse_peer"}`.
  - The woken model replied "No action needed — unsolicited peer test message ignored per runtime policy". Peer text is treated as untrusted data, not as user intent.
- The binary's admission vocabulary is `allow_once | reject_once | allow_connected | block_connected | exact_profile_match | authenticated_controller | authenticated_external_agent`. This suggests an external agent would face a per-message (`allow_once`) or per-connection (`allow_connected`) prompt, unless it authenticates. This is UNVERIFIED and comes from strings only.

### 8. Windows settings path and hook shell: UNTESTED

- There is no Windows machine on this host. Static hints only, from `muse-x86-windows.exe` 1.4.3-R5018.1 (sha256 `dd510f81…`, from the public release manifest):
  - Its embedded docs and skills mention only `$XDG_CONFIG_HOME/muse` / `$HOME/.config/muse`, with no `AppData` or `Roaming` strings.
  - The model shell tool is "Windows PowerShell" (`powershell.exe -NoLogo -NoProfile -Command`), and `cmd.exe /C` (via `COMSPEC`) also appears.
- Which of these runs **hook** commands is not determinable statically. Khala hook commands must stay shell-neutral: a single argv-style `khala hook <event>` with no pipes, quoting or `$VAR` expansion.

## Consequences for dependent units

- **U33 (#1143), Muse adapter:**
  - Steer = `PostToolUse` → `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext": "<text>"}}`. Never emit top-level `additionalContext`, because it fails the hook. Plain stdout is ignored.
  - Sync = `Stop` → `{"decision":"block","reason":"<text>"}`, gated on `stop_hook_active`.
  - Registry capabilities: `steer: true`, `sync: true`.
  - Session identity: `env` `MUSE_SESSION_ID` for `khala mcp` (item 4 PASS). Hooks have no `MUSE_SESSION_ID` env, so hook commands must read `session_id` from stdin.
  - Install, choosing either path:
    - (a) write `hooks` and `mcp_servers` into `~/.config/muse/settings.json`, preserving `schema_version` and siblings and accepting the `mcpServers` spelling; or
    - (b) ship a native `.muse-plugin` (or reuse the Claude plugin) and run `muse plugins install <dir> --scope user` and then `muse plugins approve khala`. `approve` is a one-time user step per definition hash, so the install output must say so.
  - Drop `asyncRewake` for Muse.
  - String hook commands run under the user's `$SHELL`, which may be zsh or fish, so keep them POSIX-trivial.
- **U40 (#1126), Muse gaps:**
  - Item 5 FAIL, so Muse's wake ladder rung 1 (peer session messaging) is **unavailable** on 1.4.3. Wake uses the terminal rung (4), or the editor terminal (3, U41).
  - U40 pursues the native path. `muse session-message send` exists, but it is blocked by the `external_agent_ingress` gate and by `causal_metadata_invalid` admission.
  - Re-test when Meta enables `external_agent_ingress` for the account, then answer item 7: what approval looks like (`allow_once` vs `allow_connected`) and whether it persists.
- **HB3 (Muse on Windows and per-session peer approval):** still provisional. Item 8 stays UNTESTED, and peer approval could not be reached.
- **Registry and docs:** record `muse` as `steer: hook-additionalContext (hookSpecificOutput only)`, `sync: stop-block`, `session: env MUSE_SESSION_ID (MCP) / stdin session_id (hooks)`, `wake rung 1: unavailable (external_agent_ingress gated, 1.4.3)`.

## Operator notes

- **Auto-update:** Muse auto-updated from **1.4.0** (build `aebe0c188b`, recorded in the operator's Sep 27–28 local traces) to **1.4.3-R5018.1**. The binary `~/.local/bin/muse-bin-1.4.3-R5018.1` was written at 2026-10-05 21:36:29 PDT, on the first launch of the earlier, stopped run of this spike, which did not set `MUSE_NO_AUTO_UPDATE`.
  - The launcher deletes old `muse-bin-*`, so 1.4.0 is gone.
  - This run's `muse --version` (via the launcher) did an update check at 23:07:29 and found no change. Every other call used the versioned binary with `MUSE_NO_AUTO_UPDATE=1`.
- `~/.local/share/muse/session-name-authority/session-names.db` (real home) gained 12 `canonical` name claims from spike sessions: 7 from this run, plus earlier spike runs including #1118's. Muse resolves this path outside `HOME`/`XDG_*`. It holds session-name reservations only and was left as is. The operator's own claim from Sep 27 is untouched.
- To finish item 8: on a Windows machine, install Muse (`irm https://dev.meta.ai/install.ps1 | iex`), then run `muse` once and note the settings file it creates or reads. Then add a `SessionStart` hook with `"command": "echo %COMSPEC% $PSVersionTable.PSVersion > %TEMP%\\muse-shell.txt"` and read which half expanded.
