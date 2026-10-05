# Gemini CLI as a Khala host (research as of 2026-10-04)

Latest stable seen: v0.62.0 (2026-09-29); v0.63 preview, v0.64 nightly
(https://api.github.com/repos/google-gemini/gemini-cli/releases).
Confidence note: facts below come from official docs (main branch) fetched via summarizer; items marked [UNVERIFIED] were not confirmed in primary text.

## 1. MCP config
- Locations: `~/.gemini/settings.json` (user), `.gemini/settings.json` (project).
  docs/tools/mcp-server.md: "~/.gemini/settings.json ... .gemini/settings.json"
- Stdio schema under `mcpServers.<name>`: `command` (required), `args`, `env`, `cwd`, `timeout` (default ms, e.g. 30000), `trust`, `includeTools`, `excludeTools`.
  Example:
  `{"mcpServers":{"khala":{"command":"khala","args":["mcp"],"env":{"KHALA_TOKEN":"$KHALA_TOKEN"},"trust":true}}}`
- Env expansion: "`$VARIABLE_NAME`, `${VARIABLE_NAME}` (all platforms), or `%VARIABLE_NAME%` (Windows only)... If a variable is not defined ... it resolves to an empty string."
- Trust: "When `"trust": true`, the server bypasses confirmation dialogs" (per-tool-call approval prompts). Without it each khala_* call prompts (unless yolo/policy allow). `--allowed-mcp-server-names` flag exists.
- CLI mgmt: `gemini mcp add|list|remove`; in-session `/mcp`. Reload: no explicit documented `/mcp reload` found [UNVERIFIED]; restart session is the safe answer. list_changed notification support not confirmed.
- Tool names are exposed to model/hooks as server-prefixed (e.g. `mcp_khala_khala_send`) [UNVERIFIED exact format]; matcher is regex.

## 2. Hooks (the key capability)
Source: https://geminicli.com/docs/hooks/reference/ and docs/hooks/*.md
- Arrived v0.26.0 (Jan 2026), enabled by default: "Hooks are now officially enabled by default" (https://github.com/google-gemini/gemini-cli/discussions/17812). `gemini hooks migrate --from-claude` exists (devops/blog summary).
- Events (11): BeforeTool, AfterTool, BeforeAgent, AfterAgent, BeforeModel, BeforeToolSelection, AfterModel, SessionStart, SessionEnd, Notification, PreCompress. (No "Stop"; AfterAgent is the analogue.)
- Config (settings.json or extension hooks/hooks.json):
  `{"hooks":{"AfterTool":[{"matcher":"regex","hooks":[{"name":"x","type":"command","command":"...","timeout":5000}]}]}}`
  Required: type, command. Default timeout 60000 ms. Command hooks only; run synchronously: "the CLI waits for completion".
- Input (stdin JSON), all events: `session_id, transcript_path, cwd, hook_event_name, timestamp` plus event fields (tool_name, tool_input, tool_response for AfterTool; prompt for BeforeAgent; prompt_response/stop_hook_active for AfterAgent [last two UNVERIFIED]).
- Output: "decision: allow|deny|block", "reason", "continue: false" ("terminate the agent loop"), "systemMessage" (shown to user), "suppressOutput", "hookSpecificOutput".
- Exit codes: 0 = parse stdout JSON; 2 = "System Block; stderr contains rejection reason"; other = non-fatal warning.
  Rule: "Always write logs to stderr. Write only the final JSON to stdout."
- AfterTool `hookSpecificOutput.additionalContext`: "Text that is **appended** to the tool result for the agent." => STEER primitive: runs after every tool (incl. non-Khala tools), tool not aborted, text lands in the model's next request.
- BeforeAgent `additionalContext`: "appended to the prompt for this turn only" (fires after user submits, before planning). SessionStart also takes additionalContext.
- AfterAgent (once per turn after final response): `decision:"deny"` + reason -> "reject the response and force a retry. The text is sent to the agent as a new prompt requesting correction." => SYNC primitive: hook can force one more model round at end of turn carrying channel messages. `clearContext:true` also exists. Cannot start a turn when idle.
- Project hooks fingerprinted: "If a hook's name or command changes ... it is treated as a new, untrusted hook and you will be warned".
- Hook env: `GEMINI_SESSION_ID`, `GEMINI_PROJECT_DIR`, `CLAUDE_PROJECT_DIR` (alias), `GEMINI_PLANS_DIR`, `GEMINI_CWD` (docs/hooks/index.md).
- Hooks are separate processes: they must read channel state from a local file/socket owned by the Khala MCP server or a khala CLI (hook shells out `khala poll --session $GEMINI_SESSION_ID`).

## 3. Idle wake
No first-class way found. Evidence:
- "Add IPC or REST API support" #2145: closed, Stale, P3, no maintainer reply (https://github.com/google-gemini/gemini-cli/issues/2145).
- "/inject for mid-stream steering" #17197: "Closed as not planned" (https://github.com/google-gemini/gemini-cli/issues/17197).
- Remote input discussion #4225 suggests only expect/pexpect/node-pty/FIFO hacks (https://github.com/google-gemini/gemini-cli/discussions/4225).
- `--experimental-acp`: "Start in ACP mode. Experimental feature." (cli-reference.md). ACP = JSON-RPC over stdio owned by the *client* (Zed/JetBrains) spawning gemini; the user's existing terminal TUI session is not attachable. Khala could BE the ACP client, but then it is not the user's interactive session.
- `-p` is "Forces non-interactive mode"; `-i` runs prompt then continues interactive (new process). `--resume <latest|index|uuid>` combined with -p can run a headless turn against the stored session [combination not documented in headless.md; UNVERIFIED], but it is a separate process writing to the same chat file, not the live TUI.
- Interactive stdin non-TTY keep-alive #13924 closed with PR #23414 (https://github.com/google-gemini/gemini-cli/issues/13924) - enables driving a piped interactive process Khala itself spawns.
- Input queue exists: user can type while busy; queued prompts run later; modes "Wait for Idle"/"Wait for Response" (PR #7867; issue #2014). Human keystroke path only, no external API. Bug #17282: queued messages interleave during tool calls.
Closest workarounds (ranked):
 1. PTY wrapper: `khala gemini` launches gemini under node-pty/pty (or tmux) and writes text + Enter on the PTY when a message arrives and the session is idle (AfterAgent/ SessionStart hook writes idle/busy state). Works with the user's real TUI. Fragile with Windows ConPTY; paste/bracketed-paste handling needed.
 2. tmux `send-keys` into the pane (Linux/macOS).
 3. Headless `gemini --resume <id> -p "<msgs>"` spawned by khala daemon when idle (new process, output not shown in the open TUI; TUI will not reload).
 4. Khala as ACP client hosting gemini (own UI).
 5. Keep a long-running blocking MCP tool (khala_listen) so the turn never ends: breaks "idle", ties up a turn.

## 4. Session identity and resume
- Hooks: `session_id` in stdin JSON and `GEMINI_SESSION_ID` env (docs/hooks/index.md).
- MCP stdio server: no documented injection of session id into server env or `_meta` [UNVERIFIED]. Server inherits CLI env, so `GEMINI_SESSION_ID` may or may not be present; do not rely. Pattern: SessionStart hook writes `{session_id, pid, cwd}` to a Khala state dir; MCP server correlates by ppid (server's parent is the gemini process) or by khala_join arg.
- Resume: `gemini --resume` (latest) / `--resume 1` / `--resume <uuid>`; `/resume` browser. "Sessions are stored in ~/.gemini/tmp/<project_hash>/chats/" (docs/cli/session-management.md). Resumed session keeps/reuses id [UNVERIFIED]; hooks fire SessionStart with a source field [UNVERIFIED].

## 5. Packaging
- Extension manifest `gemini-extension.json`: `name, version, description, mcpServers (supports ${extensionPath}), contextFileName (e.g. GEMINI.md), excludeTools, settings (user-provided values such as API keys), themes, plan, migratedTo`; hooks in `hooks/hooks.json`. Vars: `${extensionPath}`, `${workspacePath}`, `${/}`. (docs/extensions/reference.md). Also commands/*.toml and skills (v0.26) [UNVERIFIED for this repo].
- Install: `gemini extensions install <github url|path> [--ref <ref>] [--auto-update]`; `uninstall`, `enable|disable [--scope]`, `update <name|--all>`, `link <path>`. Gallery at geminicli.com/extensions.
- Idiomatic: yes. One extension can ship MCP + hooks + context (steer/sync hooks + khala skill/GEMINI.md). Caveat: extension-provided hooks may need trust prompt/ consent on install [UNVERIFIED]. MCP server binary: use `npx khala-cli mcp` or `${extensionPath}` bundled script.

## 6. Platforms
- Windows supported (PowerShell-based shell tool; ConPTY via @lydell/node-pty). Env syntax `%VAR%` accepted. v0.62 notes mention ConPTY/PTY lifecycle fixes.
- Quirks: node-pty binary missing if installed with `--omit=optional` (#16003); runs everything in PowerShell even under Git Bash (#12678); unusable where cmd/PowerShell are policy-disabled (#26567); MCP stdio servers crashing on launch (#2266); npm wrapper `"-S"` failure (#20697); ACP on Windows PATH unset (JetBrains LLM-26554). Hook `command` runs via shell: write portable commands (`node script.js`), use `${/}`.
- Idle-wake via PTY on Windows is the riskiest piece; tmux not available.

## Mapping
| Khala feature | Verdict | Evidence |
|---|---|---|
| MCP server (5 tools, stdio, env) | SUPPORTED | settings.json mcpServers command/args/env/trust |
| Trust / no approval prompts | SUPPORTED | `trust:true`; policy/yolo alternatives |
| Steer (inject after tool, no abort) | SUPPORTED | AfterTool hookSpecificOutput.additionalContext "appended to the tool result" (v0.26+); hook reads local Khala state |
| Sync (inject at end of turn) | WORKAROUND | AfterAgent decision:deny+reason re-prompts as new prompt (forces extra round, only when messages pending; loop-guard needed). Or BeforeAgent additionalContext next turn |
| Async (read on demand) | SUPPORTED | plain MCP tools khala_read |
| Idle wake in live TUI | WORKAROUND (no native API) | #2145 and #17197 closed; only PTY/tmux keystroke injection, or headless --resume (not the live TUI) |
| Session id for hooks | SUPPORTED | session_id stdin + GEMINI_SESSION_ID |
| Session id for MCP server | WORKAROUND | SessionStart hook writes mapping; ppid correlation |
| Resume | SUPPORTED | --resume latest/index/uuid |
| Packaging as extension | SUPPORTED | gemini-extension.json + hooks/hooks.json + `extensions install <url>` |
| Windows | WORKAROUND | works but ConPTY/PowerShell quirks; PTY wake fragile |
| Inject mid-tool without finishing it | IMPOSSIBLE | hooks are synchronous and only fire at tool/agent boundaries; /inject rejected |
