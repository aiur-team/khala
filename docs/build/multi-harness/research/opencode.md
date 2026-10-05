# OpenCode as Khala host (researched 2026-10-04)
Verdict: viable. MCP gives tools; a companion JS plugin is REQUIRED for steer/sync/idle-wake because MCP subprocesses see no session id or server URL.
Caveat: docs pages were read via a summarizing fetcher; items marked (verify) were not confirmed from primary source text.

## 1. MCP config
- Lives under the `mcp` key of opencode.json: https://opencode.ai/docs/mcp-servers/ -> "Add each MCP with a unique name."
- Scope: global ~/.config/opencode/opencode.json, project ./opencode.json (project overrides, merged). (verify exact merge, standard config docs https://opencode.ai/docs/config/)
- Local schema (https://opencode.ai/docs/mcp-servers/): `type:"local"`, `command` (ARRAY, not string+args), `cwd`, `environment` (NOT `env`), `enabled`, `timeout`.
```json
{"mcp":{"khala":{"type":"local","command":["npx","-y","khala-cli","mcp"],"environment":{"KHALA_TOKEN":"..."},"enabled":true}}}
```
- Enable/reload: `enabled:false` disables without removing. Config is read at startup; assume restart needed to pick up edits (verify; no hot-reload documented). TUI has an MCP toggle.
- Quirk: key is `environment`; a Khala installer that writes `env` would be silently ignored.

## 2. Plugins
- Locations (https://opencode.ai/docs/plugins/): project `.opencode/plugins/`, global `~/.config/opencode/plugins/` (older docs/brief used singular `plugin/`; verify which dirs are scanned, ship the npm path to avoid this). npm cache: ~/.cache/opencode/node_modules/.
- npm: opencode.json `"plugin": ["opencode-helicone-session","@my-org/custom-plugin"]` (same page). Installed with Bun at startup.
- Plugin fn receives `{project, directory, worktree, client, serverUrl, experimental_workspace, $}`. Source: https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts -> "PluginInput includes: client, project, directory, worktree, experimental_workspace, serverUrl (a URL object), and $ (BunShell)".
- Events (via `event` hook, docs list): command.executed, file.edited, file.watcher.updated, installation.updated, lsp.client.diagnostics, lsp.updated, message.part.removed/updated, message.removed/updated, permission.asked/replied, server.connected, session.created/compacted/deleted/diff/error/idle/status/updated, todo.updated, tui.prompt.append, tui.command.execute, tui.toast.show.
- Hooks (Hooks interface, source above): `chat.message` (sessionID, agent, model, messageID; can edit UserMessage+parts), `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before`, `tool.execute.after`, `shell.env`, `tool.definition`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete`, `experimental.provider.small_model`, plus `event`, `config`, `tool`, `auth`, `provider`, `dispose`.
- Append context to the NEXT model request: yes. `experimental.chat.messages.transform` (mutate message array) and `experimental.chat.system.transform` (mutate system prompt) run before each LLM call, i.e. every step including after tool calls. Experimental = may change.
- Mutate tool result: `tool.execute.after(input, output)` can edit the output so Khala text rides in the tool result (steer, no abort). (verify output.output mutability in current source)
- Inject a message: SDK https://opencode.ai/docs/sdk/ -> `session.prompt()` body `parts`, `noReply` ("Inject context without triggering AI response (useful for plugins)"). Exact: `client.session.prompt({path:{id}, body:{parts:[{type:"text",text}], noReply:true}})` adds a user message with no turn. Without noReply it starts a turn (blocking). Non-blocking: `client.session.promptAsync(...)` = HTTP POST /session/:id/prompt_async.
- TUI: `client.tui.appendPrompt({body:{text}})` -> POST /tui/append-prompt; `client.tui.submitPrompt()` -> POST /tui/submit-prompt (https://opencode.ai/docs/server/ "Append text to the prompt", "Submit the current prompt"). Fragile: depends on TUI prompt focus/draft state; prefer promptAsync.
- No `session.chat` in current SDK (renamed `session.prompt`).

## 3. Idle wake
- API: `POST /session/:id/prompt_async` "Send a message asynchronously (no wait)"; `POST /session/:id/message` waits for the reply. Body {parts:[{type:"text",text}], model?, agent?}. Spec at `http://<host>:<port>/doc`.
- Works on the user's EXISTING session because the TUI is a client of the same server; the TUI updates live from the SSE stream `GET /event`.
- Port: default `127.0.0.1:4096` for `opencode serve`; the TUI "randomly assigns a port and hostname" unless `--port/--hostname` are passed (https://opencode.ai/docs/server/). Inside a plugin: use `serverUrl` from PluginInput (no discovery needed) and the injected `client` (already authed). External process: needs `opencode --port N` (or config `server.port`) or a plugin that writes serverUrl to a file/socket. Auth: `OPENCODE_SERVER_PASSWORD`, basic auth user `opencode`.
- Session id: plugin gets it per hook (`session.idle` event properties.sessionID, `chat.message` input.sessionID, tool ctx). List: GET /session. Active-session discovery from outside: track latest `chat.message`/`session.status` in the plugin.
- Proven pattern in the wild: https://github.com/brandopakel/AgentDocker/pull/247 -> "`session.idle` sends Stop; a `block` answer, meaning messages are waiting, resumes the session with `client.session.promptAsync`." And https://github.com/hhsw2015/agenthop/pull/5 (native idle-push via plugin).
- Busy-session race: guard with `session.status` (idle vs busy) before promptAsync; queueing behaviour when busy not confirmed (verify).

## 4. Session identity
- MCP server (stdio child): gets NO session id or server URL. Evidence: search result summarizing AgentDocker PR #247 "OpenCode's MCP subprocesses get no server URL / session id, so an MCP server can't inject." Env passes only what `environment` sets. (Our own test advised.)
- Plugin: sessionID in hooks; custom tools (plugin `tool` hook / .opencode/tools) get ctx `sessionID, agent, directory, worktree` (https://opencode.ai/docs/custom-tools/).
- Stability: id is persistent across resume (`opencode -c`, `-s <id>`); new id on /new. Subagent child sessions have their own ids (filter by parentID).
- Implication: bind MCP<->session via a plugin-side shim: plugin sets `shell.env`? (only for shell tool, not MCP). Better: ship Khala tools as plugin `tool` entries (get sessionID natively), or have the plugin talk to the Khala MCP/daemon over a local socket keyed by sessionID.

## 5. Packaging
- Idiomatic: one npm package exporting the plugin; user adds to opencode.json `"plugin":["khala-opencode"]` (auto-installed). Plugin can register MCP itself through the `config` hook (mutate config.mcp.khala) -> single-line install, avoids the `environment` pitfall.
- `opencode mcp add` EXISTS (https://opencode.ai/docs/cli/): "will guide you through adding either a local or remote MCP server" (interactive; not scriptable well). Also `opencode mcp list/auth`.
- Skills/AGENTS.md: instruct the agent via AGENTS.md or plugin system.transform (no marketplace equivalent of Claude plugin).

## 6. Models
- Providers via models.dev + AI SDK: Anthropic, OpenAI, Moonshot/Kimi, DeepSeek, Qwen, OpenRouter, Ollama/LM Studio/local OpenAI-compatible. MCP tools, plugin hooks and session API sit above the provider layer, so the integration is model-agnostic. Caveat: weak local models call tools poorly; injected text arrives as user/tool text, no provider-specific features used. (https://opencode.ai/docs/providers/ not fetched this pass; verify.)

## 7. Windows
- Docs strongly recommend WSL (https://opencode.ai/docs/windows-wsl/): "WSL offers better file system performance, full terminal support, and compatibility with development tools". Hybrid: server in WSL, Desktop on Windows via localhost:4096.
- Native stdio MCP: reported failures with `npx` (npx.cmd needs shell) -> use `["cmd","/c","npx",...]` or absolute node path. Issues: https://github.com/anomalyco/opencode/issues/12229 (npx stdio handshake timeout), https://github.com/anomalyco/opencode/issues/27771.
- Plugin runs under Bun on Windows; `$` shell is Bun's. Paths: use path.join, avoid bash-only commands.
- Repo moved sst/opencode -> anomalyco/opencode (issues URLs above).

## Feature matrix
| Khala feature | Status | Evidence / mechanism |
|---|---|---|
| MCP stdio server + 5 tools | SUPPORTED | `mcp.<name>.type:"local"`, `command[]`, `environment` (mcp-servers doc) |
| khala_join/status/read/send/event tools | SUPPORTED | plain MCP tools; session-aware variants via plugin `tool` ctx.sessionID |
| Session identity for MCP | WORKAROUND | MCP child gets no sessionID; use plugin tools or plugin<->daemon bridge |
| Async mode (read on demand) | SUPPORTED | pure MCP tool calls |
| Sync mode (inject at end of turn) | SUPPORTED | plugin `event` session.idle -> `client.session.prompt/promptAsync` with parts (docs: sdk, server) |
| Steer mode (after tool call, no abort) | WORKAROUND | `tool.execute.after` output append and/or `experimental.chat.messages.transform` before next LLM step; experimental hooks, may break; no first-class "inject mid-turn" API. `prompt noReply:true` while busy is another path (verify queue semantics) |
| Idle wake in existing session | SUPPORTED | `client.session.promptAsync` / POST /session/:id/prompt_async; proven by AgentDocker PR 247; requires plugin (serverUrl+client) or known --port |
| Wake from external process | WORKAROUND | needs fixed `--port`/`server.port` + OPENCODE_SERVER_PASSWORD, and session id lookup via GET /session |
| Model-agnostic (Kimi/DeepSeek/Qwen/local) | SUPPORTED | provider layer is below MCP/plugin/server API (tool-calling quality varies by model) |
| One-command install | SUPPORTED | npm plugin in `plugin` array + `config` hook registers MCP; `opencode mcp add` exists but interactive |
| Windows native | WORKAROUND | WSL recommended; use cmd /c or absolute node for stdio; npx issues #12229 |
| Hot reload of MCP/plugin | WORKAROUND | restart OpenCode after config change (no documented hot reload) |
