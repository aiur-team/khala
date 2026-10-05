# Copilot CLI, VS Code Copilot, and a VS Code/Cursor companion extension (as of 2026-10-05)
Method: primary docs fetched 2026-10-05 (docs.github.com, `microsoft/vscode-docs` + `microsoft/vscode` main,
`github/copilot-sdk` main), local `copilot` 1.0.91 `--help`. No editor run locally; UNVERIFIED = needs B.5 self-test.

## Corrections to landscape.md / gaps.md
- landscape.md says VS Code hooks are "same format as Claude Code (`chat.useClaudeHooks`)". Partly wrong. VS Code now has
  per-harness hooks: "The selected agent harness determines which hook implementation runs" (vscode-docs
  `agent-customization/hooks.md`). The **Local** harness uses VS Code's own schema. The **Copilot** harness (Agent Host)
  "use[s] the same SDK hook implementation as Copilot CLI". `chat.useClaudeHooks` only affects Local.
- landscape.md: Copilot wake "Partial: ACP / SDK ?". Better: CLI **extensions** (`joinSession`+`session.send`) attach to the user's running session (A.5).
- gaps.md 1.3 "focus-dependent": in VS Code `chat.open` `isPartialQuery:false` really submits, no OS focus (B.1). Cursor caveat stands.

## A. GitHub Copilot CLI and VS Code Copilot (agent mode)
### A.1 MCP config
- CLI: "The server is added to the user configuration at `~/.copilot/mcp-config.json`." Project: "`.mcp.json` (in any
  directory from your working directory up to the repository root) [and] `.github/mcp.json`"
  ([add-mcp-servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)).
  Schema: top-level `mcpServers`, entries `{type:"local"|"stdio"|"http"|"sse", command, args, env, tools}`.
- VS Code: "`.vscode/mcp.json` in your workspace or in your user profile ... top-level `servers` object". Portable format:
  "`.mcp.json` ... or `~/.copilot/mcp-config.json` ... top-level `mcpServers`". "The Agent Host reads the portable
  format directly" (vscode-docs `agents/reference/mcp-configuration.md`). So one `~/.copilot/mcp-config.json` entry serves
  the CLI and VS Code Agent-Host Copilot sessions. Local sessions need `servers` in the user `mcp.json`.
### A.2 Hooks (Copilot CLI = VS Code "Copilot" harness)
Source: [hooks-reference](https://docs.github.com/en/copilot/reference/hooks-reference). Files: `.github/hooks/*.json`,
`~/.copilot/hooks/*.json` (or `$COPILOT_HOME/hooks/`), inline `hooks` in `~/.copilot/settings.json`, plugin `hooks.json`.
Format `{ "version": 1, "hooks": {...} }`; command fields `bash`/`powershell`/`cwd`/`env`/`timeoutSec` ("Default: `30`").
- Events: sessionStart, sessionEnd, userPromptSubmitted, userPromptTransformed, preToolUse, postToolUse,
  postToolUseFailure, agentStop, subagentStart/Stop, errorOccurred, preCompact, notification, permissionRequest.
  PascalCase names give the "VS Code compatible" snake_case payloads.
- **Steer:** "The `postToolUse` hook can modify the tool result or inject additional context for the model"
  (`additionalContext`, or `modifiedResult.textResultForLlm`).
- **Sync:** agentStop: "`\"block\"` forces another agent turn using `reason` as the prompt." Input carries `stop_hook_active`.
- **Wake primitive:** `notification` "fires asynchronously ... fire-and-forget: they never block the session". Output
  `additionalContext` "is injected into the session as a prepended user message. This can trigger further agent
  processing if the session is idle." Types: `shell_completed`, `shell_detached_completed`, `agent_completed`,
  `agent_idle` (background agents only), `permission_prompt`, `elicitation_dialog`. No type fires when the *main* agent
  goes idle, so this alone is not an idle wake. It is a backup path (A.5).
- Exit codes: "`2` — Treated as a warning by default"; timeouts fail open. Unlike Claude, so Khala must emit JSON, not exit 2.
### A.3 VS Code Local harness hooks (default "Local" session target)
Source: vscode-docs `agents/reference/hooks-reference.md`. Events: SessionStart, UserPromptSubmit, Pre/PostToolUse,
PreCompact, SubagentStart/Stop, Stop. Files: `.github/hooks/*.json`, `.claude/settings*.json`, `~/.copilot/hooks/*.json`,
`~/.claude/settings.json`, plugin `hooks.json`. "The VS Code hooks experience is in Preview."
- Steer: PostToolUse `hookSpecificOutput.additionalContext` ("Additional context for the model"). Sync: Stop `decision:"block"`, "`reason` ... Required ... Explains why the agent should continue"; check `stop_hook_active`.
- Exit `2`: "Treat stderr as a blocking error and provide it to the model." There is no async or notification event, so no hook wake.
### A.4 Session id
- CLI hooks: `sessionId` (camelCase) or `session_id` (PascalCase config). `/session id` prints it; `copilot --resume <id>`.
- VS Code Local: "`session_id` | string | Optional identifier for the current agent session." Optional means Khala needs
  a fallback key (workspace + `transcript_path`). Agent-Host Copilot sessions carry the CLI `sessionId`.
### A.5 Idle wake: Copilot CLI
1. **CLI extension (recommended).** "The CLI scans `.github/extensions/` ... and `~/.copilot/extensions/`" for
   `extension.mjs`; "The single call to `joinSession` ... connects the running process to your session"
   ([create-an-extension](https://docs.github.com/en/copilot/tutorials/create-an-extension)). The SDK `session.send()`
   "Sends a message to this session and returns once it is admitted"; `mode?: "enqueue" | "immediate"` with enqueue as the
   default (`copilot-sdk/nodejs/src/session.ts`, `types.ts`). A Khala extension watches `inbox.jsonl` and sends
   "Khala: N channel messages waiting; call khala_read" while idle. With `immediate` while busy, it could also replace
   Steer. Caveat: "extensions are currently an experimental feature". This needs `experimental: true` in
   `~/.copilot/config.json` ("Can be enabled with --experimental flag, /settings experimental on", `copilot help config`).
   The installer can set that once, which needs no wrapper. Plugin-shipped extensions were fixed in copilot-cli#3023
   (closed 2026-09-23). A third-party Telegram bridge uses this exact pattern
   ([codewithdan](https://blog.codewithdan.com/using-telegram-with-github-copilot-cli/)). UNVERIFIED locally:
   does `send` while idle start a turn in the TUI with no keypress? The SDK docs imply yes ("When this send starts a run").
2. **Notification hook backup.** A long `timeoutSec` notification hook returns `additionalContext` when Khala has unread
   messages. It is documented to wake an idle session, but it needs some notification to fire after idle. That makes it
   opportunistic (shell/subagent completion), not reliable.
3. Remote control: "Remote commands are polled by Copilot CLI from GitHub and injected into your local session"
   ([about-remote-control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control)).
   There is no public API, so it is not usable. ACP (`copilot --acp`) or SDK headless mode is a second process, not the
   user's session, so it is ruled out.
### A.6 Idle wake: VS Code Copilot
No hook or MCP mechanism exists. Chat participants (`vscode.chat`) answer only when invoked. `vscode.lm` calls a model
directly, outside the user's session. Both are BLOCKED. The only path is the companion extension (B). For Agent-Host
Copilot sessions, whether CLI extensions load is UNVERIFIED.
### A.7 Install path
CLI: `~/.copilot/mcp-config.json` + `~/.copilot/hooks/khala.json` + `~/.copilot/extensions/khala/extension.mjs`, or one
Copilot plugin (`copilot plugin install`) bundling hooks/MCP/extension. VS Code: the companion extension can register
MCP via `vscode.lm.registerMcpServerDefinitionProvider` (stable in `vscode.d.ts`) or write user `mcp.json`, plus
`~/.copilot/hooks/` (read by both Local and the CLI). Hooks carry `--harness copilot` vs `--harness vscode`, keyed off payload casing.

## B. Companion extension for idle wake (VS Code Copilot Chat and Cursor)
### B.1 VS Code: submit into the open chat
`workbench.action.chat.open` accepts `IChatViewOpenOptions` (`microsoft/vscode` main,
`src/vs/workbench/contrib/chat/browser/actions/chatActions.ts`):
- `query`; `isPartialQuery` "Whether the query is partial and will await more input from the user"; `mode`;
  `blockOnResponse` "Wait to resolve the command until the chat response reaches a terminal state"; `preserveInput`
  "Submits `query` without taking over the input box, keeping any draft the user has typed".
- The target is `widgetService.lastFocusedWidget`, revealed if needed, which is **the chat the user last used**. With
  `isPartialQuery:false` it calls `chatWidget.acceptInput(...)`, which is a real submit. VS Code itself uses
  `{mode:'agent', query:'/init', isPartialQuery:false}`.
- Focus: the action calls `chatWidget.focusInput()`, which moves DOM focus inside the window, and `revealWidget()`. It
  never calls `hostService.focus`. So there is **no OS focus steal**, but the chat view is revealed in that window's
  sidebar. Minimized or unfocused windows: UNVERIFIED (Electron background throttling); this needs a test.
- While a request runs, the message goes through `chat.requestQueuing.defaultAction` ("`queue` ... `steer`").
- Call it with `{query, isPartialQuery:false, preserveInput:true, mode:'agent'}`; `workbench.action.chat.submit` is not needed.
- Risk: the command is public and documented (keybinding table), but its options object is internal and not part of
  `vscode.d.ts`, so the shape can change. Also, the last-focused chat may not be the Khala-bound session.
### B.2 Cursor
- Documented extension API: only `vscode.cursor.mcp.registerServer/unregisterServer` and
  `vscode.cursor.plugins.registerPath/unregisterPath`. Per [extension-api](https://cursor.com/docs/extension-api) there
  is no chat or composer submit API.
- Forum: `workbench.action.chat.open` "fills the prompt text, but it doesn't auto-send it". `composer.startGeneration` and
  `workbench.action.chat.submit` exist, but "those aren't official commands, and availability depends on the version"
  ([157654](https://forum.cursor.com/t/is-it-possible-to-submit-chat-programmatically/157654)). Staff said a prompt-arg
  command shipped in "Cursor 2.3!" (2026-01-08,
  [138049](https://forum.cursor.com/t/a-command-for-passing-a-prompt-to-the-chat/138049)), but which command and its
  arguments are undocumented. Deeplinks "never trigger automatic execution" (gaps.md 1.4).
- Plan: try in order `workbench.action.chat.open {query, isPartialQuery:false}`, then
  `composer.focusComposer` (or `aichat.*`) + `composer.startGeneration`. Gate on `vscode.commands.getCommands(true)` and
  an allowlist of Cursor versions. Never use the clipboard-paste path: it clobbers the user's clipboard and needs editor focus.
- Bonus: `vscode.cursor.plugins.registerPath` lets the same extension install Khala's Cursor hooks and MCP plugin.
### B.3 Learning of new messages
Watch `~/.local/state/khala/<harness>/<session>/inbox.jsonl` and `activity.json` with `fs.watch` plus a 2s poll fallback.
This uses the same files the Claude and Codex wakers use. It needs no new port and no new auth surface. Wake only when:
mode is not async, activity is idle (no hook event in the last N s), unread > 0, and the wake debounce matches Codex
(max 2 wakes per delivered-count, 60s retry). For session binding, the extension maps `workspaceFolder` to a session dir,
using the dir the hook last wrote for this workspace. Skip a localhost socket unless a remote/SSH window needs one later.
### B.4 Distribution
One `.vsix` (engines `vscode` set to the lowest version Cursor ships). Publish to VS Code Marketplace (VS Code) and Open
VSX (Cursor's panel "searches Open VSX through a proxy at marketplace.cursorapi.com"). `khala install` can also
sideload with `code --install-extension khala.vsix` / `cursor --install-extension khala.vsix`, which is a one-time CLI
call with no launch. Sideloading avoids marketplace lag and needs no auto-update.
### B.5 Risks and failure detection
- Version breakage (Cursor especially). On activation, probe `getCommands(true)`. Disable wake and write
  `companion.json {ok:false, reason}` if the command is missing or the editor version is not on the allowlist. `khala status` surfaces it.
- Silent no-op, where the command resolves but nothing is sent. Embed a nonce in the wake text. Treat the wake as
  successful only if a UserPromptSubmit / beforeSubmitPrompt / userPromptSubmitted hook reports a prompt containing
  the nonce within 10s. Otherwise count a failure. After 2 failures, fall back to "no idle wake" and send an OS
  notification (no focus).
- Wrong chat (several open): compare the hook's `session_id` with the nonce owner; log mismatches. Wake turns cost
  premium requests, so the setting is opt-in and off by default.

## Recommendation
| Feature | Copilot CLI | VS Code Copilot (agent mode) | Cursor |
|---|---|---|---|
| MCP tools | SUPPORTED (`~/.copilot/mcp-config.json`) | SUPPORTED (user `mcp.json` `servers`; Agent Host also reads `~/.copilot/mcp-config.json`) | SUPPORTED (`~/.cursor/mcp.json`) |
| Steer (after tool call) | SUPPORTED (postToolUse `additionalContext`) | SUPPORTED (PostToolUse `hookSpecificOutput.additionalContext`; Preview) | SUPPORTED (postToolUse `additional_context`) |
| Sync (turn end) | SUPPORTED (agentStop `decision:block` + `reason`) | SUPPORTED (Stop `decision:block` + `reason`) | SUPPORTED (stop `followup_message`) |
| Async (on demand) | SUPPORTED (`khala_read`) | SUPPORTED (`khala_read`) | SUPPORTED (`khala_read`) |
| Session id | SUPPORTED (`sessionId`) | WORKAROUND (`session_id` optional; fall back to workspace + transcript_path) | WORKAROUND (workspace folder, per gaps.md) |
| Idle wake | WORKAROUND (Copilot CLI extension `joinSession`+`session.send`; experimental flag set once at install) | WORKAROUND (companion extension: `workbench.action.chat.open {isPartialQuery:false, preserveInput:true}`, no OS focus) | WORKAROUND, fragile (companion extension: undocumented `composer.startGeneration` / chat.open prompt arg, version allowlist + nonce self-test); else BLOCKED |
| Install | `copilot plugin` or `~/.copilot/{hooks,extensions}` | `.vsix` (Marketplace or sideload) + `~/.copilot/hooks` | same `.vsix` via Open VSX or `cursor --install-extension`; `vscode.cursor.plugins.registerPath` |
