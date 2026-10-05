# Listener-mode gaps: Claude Code, Codex CLI, Cursor (as of 2026-10-04)
Method: repo read via `git show origin/main:` plus WebFetch/WebSearch. "UNVERIFIED" marks claims I could not confirm
from a primary doc. I did not run Cursor locally; every Cursor verdict is doc-based.
## 0. What Khala does today (origin/main, packages/agent)
- Claude: hooks.claude.json -> PostToolUse / UserPromptSubmit / Stop run `hook deliver --harness claude`. Stop also
  runs `hook claude-wake` with `"asyncRewake": true, "timeout": 3300`. hooks/claude-wake.ts polls activity.json
  (idle), mode.json (not async) and inbox.jsonl unread count. On unread it writes the NOTICE to stderr and exits 2.
  Its deadline is 3000s, so a session idle longer than ~50 min loses the wake until the next Stop re-arms it.
- Codex: src/wake/codex.ts is a 1s-poll debounced waker. It runs `codex queue --thread <id> --message "Khala:
  channel messages are waiting. Continue."`. Max 2 wakes per delivered-count, 60s retry. The UserPromptSubmit hook then pulls.
  Hooks: PostToolUse / UserPromptSubmit / Stop (hooks.codex.json).
- Cursor: install/cursor.ts registers beforeSubmitPrompt, postToolUse, stop; MCP env KHALA_CURSOR_WORKSPACE.
  Session = workspace folder. docs/install-cursor.md states "No idle wake". Stop returns `followup_message`
  (Sync); postToolUse returns `additional_context` (Steer).
- Observation: install registers `beforeSubmitPrompt`, but Cursor's documented output for it is only `continue` and
  `user_message`. It cannot inject context. Verify that hook is actually delivering anything (see section 1.5).
## 1. Cursor idle wake: options, ranked
Bottom line: no documented, supported way for an external process to start a turn in an idle IDE chat and have it
land in the SAME chat without a human click. The two real wakes (CLI --resume, Cloud Agents API) either fork a
different execution context or do not touch the open IDE chat.
### 1.1 Cursor CLI `agent` / `cursor-agent` (--resume, --print, ACP)  [rank 1 for "real wake", wrong surface]
- https://cursor.com/docs/cli/overview : `agent --resume="chat-id-here"` resumes a specific conversation; `agent -p "your prompt"`
  runs non-interactively. Docs say nothing about injecting into an existing running session: "doesn't describe a direct method to inject
  messages into an existing CLI chat session".
- ACP: https://cursor.com/docs/cli/acp, "exposes the Cursor agent as a JSON-RPC 2.0 server over stdio"; `session/new`
  and `session/load` ("Resume an existing conversation with session/load"). The docs do not say it attaches to
  an IDE chat. Treat it as an independent runtime.
- Verdict: `agent --resume <id> -p "<notice>"` really starts a turn headlessly with no click, in the persisted
  conversation of that id. But it is a SECOND process writing to the same stored chat, not the IDE's live chat. The
  IDE view will probably not refresh, and concurrent writers risk divergence (UNVERIFIED; needs a local test). It
  only works for chats created in/known to the CLI. Whether an IDE composer id is resumable by the CLI is not documented.
- Use case: a Khala-owned headless Cursor worker (own chat id) rather than waking the user's chat.
### 1.2 Cloud Agents API (formerly Background Agents)  [real wake, different agent]
- https://cursor.com/docs/background-agent/api/overview : `POST /v1/agents` ("Create a Cloud Agent and immediately enqueue its initial run");
  `POST /v1/agents/{id}/runs` = "follow-up prompt to an existing active agent. The new run uses the agent's
  current conversation and workspace state." Public beta.
- Docs make no mention of local IDE chat messaging. It works only on cloud agents (remote VM + git repo).
  Cursor SDK (https://cursor.com/changelog/sdk-release) is the same family: "Run it on your machine or on Cursor's cloud";
  no documented attach to an open IDE chat.
- Verdict: full no-click wake, but of a cloud agent, not the user's local interactive chat. IMPOSSIBLE for the same
  local chat; viable as a "Khala bot agent" product shape. `& message` in the CLI hands a convo to the cloud.
### 1.3 VS Code extension / chat commands  [rank 2; fragile, can reach the same chat]
- `workbench.action.chat.open` with a query: per forum (https://forum.cursor.com/t/is-it-possible-to-submit-chat-programmatically/157654)
  "fills the prompt text, but it doesn't auto-send it."
- Auto-submit: `composer.startGeneration` or `workbench.action.chat.submit`, but "those aren't official commands,
  and availability depends on the version." Clipboard path: `composer.newAgentChat` + `editor.action.clipboardPasteAction` + submit.
- A companion extension (loopback socket/file-watch from Khala) could call these when Khala sees unread + idle.
- Verdict: only mechanism that can plausibly drive the same live chat, no click. Undocumented commands, version-
  coupled, focus-dependent, needs a Marketplace/OpenVSX extension and a Cursor-specific release gate. Ship only behind an opt-in
  flag with a version allowlist plus a self-test, and treat as best-effort. No `workbench.action.chat.open` call can
  target a specific existing chat id (UNVERIFIED for composer.* variants).
### 1.4 Deeplinks (cursor://...)  [rank 3; click required]
- https://cursor.com/docs/integrations/deeplinks : "it opens Cursor with the prompt pre-filled in the chat. The user must review and
  confirm the prompt before it gets executed. Deeplinks never trigger automatic execution." Opens a new prompt; not same chat.
- Verdict: IMPOSSIBLE for no-click. Usable only as a "nudge" notification link.
### 1.5 Hooks (https://cursor.com/docs/hooks)
- Events: sessionStart (output `env`, `additional_context`), sessionEnd, preToolUse, postToolUse
  (`additional_context`, `updated_mcp_tool_output`), postToolUseFailure, before/afterShellExecution,
  before/afterMCPExecution, subagentStart/Stop (`followup_message`, only when completed), beforeSubmitPrompt
  (`continue`, `user_message`), preCompact, stop (`followup_message`: "Cursor will automatically submit it as the next
  user message"), afterAgentResponse/Thought, Tab hooks, `workspaceOpen`.
- All fire only inside a running agent loop (or app lifecycle). None starts a turn on an idle chat.
- Gaps to exploit: (a) sessionStart `additional_context` is a free Sync-at-start channel; (b) `afterAgentResponse`
  /`afterAgentThought` could keep activity.json fresh; (c) `subagentStop.followup_message` is another Sync point;
  (d) verify beforeSubmitPrompt really cannot inject (documented fields say no): if so the installer entry is
  dead weight, or it only serves as an activity marker.
- Ceiling: `stop.followup_message` is capped at one per turn in our impl, which makes chained Sync a sequence of
  turns rather than idle wake. `workspaceOpen` is not a per-chat event.
### 1.6 MCP features in Cursor (https://cursor.com/docs/context/mcp)
- Supported per docs: tools, prompts, resources, roots, elicitation ("Server-initiated requests for additional
  information from users"), Apps. Sampling and notifications are not listed. Forum: sampling is a feature request
  (https://github.com/cursor/cursor/issues/3023); Cursor does not act on `tools/list_changed`
  (https://forum.cursor.com/t/cursor-not-respecting-mcp-notifications-prompts-list-changed-messages/126689).
- Elicitation only fires while a tool call is in flight (inside a turn); it needs a human answer. Not a wake.
- Verdict: no MCP-native wake in Cursor.
### Cursor ranking (idle wake, same chat, no click)
| # | Option | Real wake, no click | Same live chat | Reliability |
|---|---|---|---|---|
| 1 | Companion extension + undocumented submit cmds | yes | likely | low-medium, version-coupled |
| 2 | `agent --resume <id> -p` | yes | stored convo, not live IDE view | medium; needs local test |
| 3 | Cloud Agents API `/runs` | yes | no (cloud agent) | high but off-target |
| 4 | Deeplink | no (confirm click) | no | n/a |
| 5 | Hooks / MCP notifications / sampling / elicitation | no | n/a | n/a |
Recommendation: keep "no idle wake" as the supported contract; add the extension as an opt-in experimental
workaround; offer cloud/CLI worker as a separate product mode. Add a desktop/OS notification as a human nudge.
## 2. Generic MCP mechanisms that make a host take a turn
Spec facts (https://modelcontextprotocol.io/specification/2025-11-25/changelog): 2025-11-25 added URL-mode elicitation, tool-calling in
sampling, experimental tasks (durable requests, polling), SSE polling. 2025-06-18 added elicitation and structured output.
None adds a server-initiated "start a turn" primitive.
- `notifications/resources/updated` + subscribe: informs the client a resource changed. Per discussion
  (https://harnlang.com/protocol-contributions/mcp-notifications-reminder.html): it "does not guarantee durable event delivery, wake a model, or
  start an agent turn"; the host must translate it. No major host found (Claude Code, Codex, Cursor) that turns it into a turn.
- `sampling/createMessage`: server asks the client for an LLM completion. It is a completion, not a turn in the user's
  chat, and clients gate it on user approval. Cursor does not support it. Not a wake.
- `elicitation`: asks the user for input mid-request; requires an in-flight tool call. Not a wake.
- Tasks (SEP-1686): polling of long-running requests by the client; client-driven, no wake.
- Host-specific extension that DOES wake: Claude Code `notifications/claude/channel` (section 3). It is a vendor
  extension (`experimental['claude/channel']`), not part of the MCP spec.
- Note (Claude docs): a channel server negotiating protocol revision 2026-07-28 on the v2 MCP client runtime is not
  registered as a channel. Check which protocol revision `khala mcp` negotiates if we adopt channels.
Verdict: no spec-level wake exists. Anything that wakes is a host extension.
## 3. Claude Code and Codex: remaining gaps
### 3.1 Claude Code
- Steer: PostToolUse additionalContext. SUPPORTED. Sync: Stop hook. SUPPORTED. Async: khala_read. SUPPORTED.
- Idle wake: asyncRewake. https://code.claude.com/docs/en/hooks : "`asyncRewake` ... runs in the background and wakes Claude on
  exit code 2. The hook's stderr, or stdout if stderr is empty, is shown to Claude as a system reminder." Works while
  the session is idle. Caveats: bounded by the hook timeout (we use 3300s, deadline 3000s) so long-idle sessions need
  re-arm (issue ref: https://github.com/cfaysal/kherep/issues/97 "Arm the wake listener at SessionStart"); a host that
  closes stdin/kills the CLI SIGINTs in-flight asyncRewake hooks (https://github.com/littlebearapps/untether/issues/812); the hook
  is armed on Stop only, so a session that starts and never completes a turn, or one resumed with --continue, has
  no watcher until its first Stop. Wake text is the stderr NOTICE, with the body arriving through the next hook.
- Channels (research preview): https://code.claude.com/docs/en/channels-reference : server declares
  `experimental['claude/channel']` and emits `notifications/claude/channel` {content, meta}. Docs (via search) say "An idle
  session is woken; during a turn the event lands between tool calls", which covers Steer + idle wake natively and
  in-protocol (no polling hooks). Constraints: needs `--channels` / `--dangerously-load-development-channels`
  per session (flags hidden from --help), allowlist (custom channels only via the dangerous flag + a warning dialog),
  claude.ai/Console auth only (no Bedrock/Vertex/Foundry), Team/Enterprise need `channelsEnabled`; events drop
  silently when not registered; no ack. Bug: push is silently dropped after `--continue` re-attach
  (https://github.com/anthropics/claude-code/issues/67024, closed not planned).
  Verdict: a potential upgrade path for Pro/Max users, not a replacement for hooks yet. Keep asyncRewake as the default.
- Background task completion not waking idle sessions: only a search snippet ("response waits until the next user
  interaction"); UNVERIFIED in primary docs. Khala does not depend on it (its own watcher uses asyncRewake).
### 3.2 Codex CLI
- Hooks (https://learn.chatgpt.com/docs/hooks): SessionStart (additionalContext), UserPromptSubmit, PreToolUse, PostToolUse,
  PermissionRequest, Stop (`"decision": "block"` continues with a new prompt), SubagentStart/Stop, PreCompact/
  PostCompact, Interrupt. Hooks need trust review; can be disabled by `[features] hooks = false`; `async: true` supported (max 8).
  Steer (PostToolUse) / Sync (Stop) / Async: SUPPORTED. Trust step: a fresh hooks.json is inert until the user trusts it.
- Idle wake: `codex queue --thread <id> --message` works today (https://github.com/cfaysal/kherep/pull/67: idle Codex app
  session ran a turn "within 15 seconds on macOS" - app, not necessarily TUI). Caveat: openai/codex#35542
  ("TUI cannot be woken by local same-user tooling", open) says "There is currently no supported way for a local
  same-user process to wake an idle, already-open `codex` TUI session when its persisted thread is updated
  externally." Our implementation assumes queue reaches the live TUI; re-verify per codex version in CI and
  keep the 2-wake cap. Needs thread id (we get it from the hook payload / env).
- App-server: stdio (default), WebSocket (experimental), Unix control socket. `thread/resume` subscribes a second
  connection; `turn/start` starts a turn, `turn/steer` (needs expectedTurnId) steers mid-turn
  (https://github.com/davebream/glosa/issues/161: TUI attaches to daemon socket
  `$CODEX_HOME/app-server-control/app-server-control.sock`; needs RFC 6455 handshake; `thread/resume` fails until
  one turn has run; Homebrew/npm installs cannot start the daemon). Only for TUIs started with `--remote`/daemon.
  Option for a more native mid-turn Steer; not needed today.
## 4. Per-harness table
| Harness | Steer | Sync | Async | Idle wake |
|---|---|---|---|---|
| Claude Code | SUPPORTED (PostToolUse) | SUPPORTED (Stop) | SUPPORTED (khala_read) | SUPPORTED (asyncRewake; 3300s re-arm gap; channels = preview alternative) |
| Codex CLI | SUPPORTED (PostToolUse) | SUPPORTED (Stop block) | SUPPORTED (khala_read) | WORKAROUND (`codex queue`; TUI reach contested by #35542; app-server --remote is the alternative) |
| Cursor | SUPPORTED (postToolUse additional_context) | SUPPORTED (stop followup_message, 1/turn) | SUPPORTED (khala_read) | WORKAROUND, opt-in only (companion extension calling undocumented submit commands) ; native/documented = IMPOSSIBLE; cloud API/CLI resume wake a different agent, not this chat |
