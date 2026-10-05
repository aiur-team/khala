# Idle wake without wrapping (research as of 2026-10-05)

Constraint: the user launches the agent exactly as today. No wrapper or launcher, no OS keystroke injection, no
focus change. A one-time plugin, extension, config or hook install is allowed.
Versions seen: Claude Code 2.1.289 (2026-10-03), Codex rust-v0.160.0 (2026-10-01), Gemini CLI v0.62.0 stable
(2026-09-29), Qwen Code v0.25.0 (2026-10-05). [UNVERIFIED] means not confirmed in primary text or code.

## 1. Claude Code
Today: `hooks.claude.json` runs `khala hook claude-wake` on Stop with `"asyncRewake": true, "timeout": 3300`. The
watcher stops itself at `DEADLINE_MS = 3000 * 1000`.
- **Claude Code does not enforce the timeout on Stop; the 3000s deadline is our own.** https://code.claude.com/docs/en/hooks
  "On most events, Claude Code doesn't enforce the hook's `timeout`: a background hook can run longer than its timeout
  and won't be canceled. The exceptions are `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`, and `MessageDisplay`".
  asyncRewake counts as a background hook. Schema in the 2.1.289 binary: "asyncRewake ... runs in background and wakes
  the model on exit code 2 (blocking error). Implies async." In the binary, the asyncRewake branch awaits the process
  result and registers no timer. The plain-async branch registers `asyncTimeout` (code read; not a live test).
- **Timeout defaults and maximum.** "Defaults: 600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`."
  The docs give no maximum for a hook's `timeout` field. The only documented cap is SessionEnd: "raises the budget to
  match, up to 60 seconds".
- **Session end.** "Claude Code waits up to 5 seconds for all background hooks to finish ... abandoned." The watcher
  already exits when its parent dies (`parentAlive`), so no orphan.
- **Re-arming.** Each Stop re-arms the watcher. Ownership moves through the nonce in `watcher.json`, so the previous
  watcher sees it no longer owns the file and exits. Options:
  1. Drop the deadline or raise it to about 24h, and keep the parent-alive and ownership checks. This is the simplest
     fix and is consistent with the docs. Polling every 500ms for a day is cheap. Recommended.
  2. Add a SessionStart asyncRewake watcher, which covers fresh and `--continue` sessions before their first Stop.
     The docs say SessionStart hooks "run in the background. You can type right away", but "Claude's first response
     still waits for the hooks to finish". Issue https://github.com/anthropics/claude-code/issues/89960 (open) reports
     "`asyncRewake: true` blocks just like a plain synchronous hook". That was measured in `-p` mode and, per a
     comment, in desktop stream-json mode. The binary only backgrounds asyncRewake behind a launch-mode check
     (`e.async||e.asyncRewake&&(!ke()||Rnt())`). Conclusion: safe in the interactive TUI [UNVERIFIED live], but it would
     stall the first reply in SDK, desktop and `-p` hosts. Gate it on the interactive TUI or test it.
  3. A Notification hook with matcher `idle_prompt` ("User is prompted for an input while Claude Code is idle") could
     re-spawn a watcher. How often it fires and whether asyncRewake applies to Notification are [UNVERIFIED]. Not needed
     if option 1 holds.
  Risk: https://github.com/anthropics/claude-code/issues/96148 (open) reports "Failing asyncRewake Stop hook causes
  unbounded model re-wake loop". Keep the rule "a watcher error never exits 2", which is already in the code.
- **Channels** (https://code.claude.com/docs/en/channels). Push into an open session, idle or busy. Status: "Channels are
  in research preview ... the `--channels` flag syntax and protocol contract may change". It needs a per-launch flag:
  "no channel runs until a user opts it in for the session with `--channels`", and "Being in `.mcp.json` isn't enough
  to push messages: a server also has to be named in `--channels`". Custom channels need
  `--dangerously-load-development-channels` plus "a full-screen warning dialog" unless they are on the allowlist ("The
  community marketplace is not on the channel allowlist", channels-reference). Channels need claude.ai or Console
  auth, so not Bedrock, Vertex or Foundry. Team and Enterprise need `channelsEnabled`. The 2.1.289 binary has no
  per-user setting that turns a channel on without the flag; only `channelsEnabled` and `allowedChannelPlugins` exist.
  Verdict: **violates the no-launch-change constraint**. Keep it as an opt-in upgrade for users who already launch with
  `--channels`.

## 2. Codex
- **`codex queue` is a shipped subcommand, but it is undocumented and sits on an experimental API.** PR
  https://github.com/openai/codex/pull/39092 (merged 2026-08-17): "Add `codex queue --thread <THREAD> --message <TEXT>`
  to submit a text message through the `thread/queue/add` app-server API". In `app-server-protocol/src/protocol/common.rs`
  the method is gated: `#[experimental("thread/queue/add")]`. The CLI reference at
  https://learn.chatgpt.com/docs/developer-commands?surface=cli does not list `codex queue` [checked 2026-10-05].
  There, `codex app-server` is labelled Experimental. A third-party write-up
  (codex.danielvaughan.com, 2026-08-21) says "If the agent is idle, the queued message wakes it and triggers a new turn".
- **How it reaches the TUI.** `tui/src/session_queue_commands.rs` says: "Queuing must discover the shared server to avoid
  writing through a separate server". It refuses `--no-daemon`, and it errors with "cannot queue through an embedded app
  server while a local app-server daemon is running". `tui/src/daemon_startup.rs` says "automatic launches require a
  compatible shared server", so a default TUI runs on the shared daemon and `queue` reaches it. A TUI started with
  `--no-daemon` cannot be woken.
- **openai/codex#35542** (open, filed 2026-07-27, no maintainer reply): "There is currently no supported way for a local
  same-user process to wake an idle, already-open `codex` TUI session". The issue predates `codex queue`, which merged
  three weeks later and routes through the shared daemon the TUI uses. The issue was never updated. Treat it as
  partly superseded, and keep the live re-verification in CI. Issue #48928 (open) shows TUI-visible queueing:
  "script-delivered messages wait behind long turns until a human presses **Steer**".
- **App-server `turn/start`** (https://learn.chatgpt.com/docs/app-server): "Call `turn/start` with the target `threadId`
  and user input". A Khala client would have to connect to the TUI's daemon socket (prior note: an
  `app-server-control.sock` under `$CODEX_HOME`, which needs a WebSocket handshake; davebream/glosa#161). The socket
  attach is not a documented public interface, and the app-server is Experimental. It is no more supported than
  `queue` and needs far more code. **Conclusion: no stable, documented idle-wake path exists. `codex queue` is the
  least-bad supported surface.**
- Env note: Codex clears MCP stdio server env except "DEFAULT_ENV_VARS (HOME, PATH, USER, TMPDIR, …) plus names
  listed in ... `env_vars`" (openai/codex#46244, #29124), so capture pane variables in a hook, not `khala mcp`.

## 3. Gemini CLI and Qwen Code
**Gemini CLI.** I re-verified the claims in gemini.md:
- v0.26.0 published 2026-01-28 (GitHub API), matching "hooks on by default" (#17812). Latest stable v0.62.0
  (2026-09-29); v0.63.0-preview.0 and v0.64 nightlies exist.
- https://geminicli.com/docs/hooks/reference/ : "Currently only `"command"` is supported"; no `async` field;
  "Execution timeout in milliseconds (default: 60000)". https://geminicli.com/docs/hooks/ : "Hooks run synchronously
  as part of the agent loop—when a hook event fires, Gemini CLI waits for all matching hooks to complete".
- Confirmed: AfterTool `additionalContext` "Text that is **appended** to the tool result for the agent"; AfterAgent deny
  reason "is sent **to the agent as a new prompt**"; ten events. `stop_hook_active` for AfterAgent still [UNVERIFIED].
- Context: Gemini CLI stopped serving consumer tiers on 2026-06-18 and moved them to Antigravity CLI (`agy`).
  Enterprise and API-key users continue (https://github.com/NousResearch/hermes-agent/issues/29294 and press
  coverage). This lowers Gemini's priority.

Can Gemini wake an idle session?
- There are no async hooks and no hook that fires while idle.
- An AfterAgent hook that blocks while waiting for a message keeps the turn "running" (synchronous). The TUI is not
  frozen: typed input goes to the input queue (PR #7867, per gemini.md; not re-verified). But the session never
  looks idle, a 60s default timeout applies (no documented maximum), and Esc or cancel kills the hook. The forced
  re-prompt also costs a model round. Usable only as a bounded "linger N minutes after a turn" option, not as idle wake.
- Injection paths: IPC/REST #2145 is stale and closed. `/inject` #17197 is "not planned". Mobile remote control #27289
  is "CLOSED NOT_PLANNED" with "no immediate plans". The WebSocket remote API proposal #20782 got "Due to the deep
  architectural impact" and "no immediate plans".
- `--experimental-acp` is stdio owned by the spawning client, so no external attach to an existing TUI is possible.
  The A2A server is a separate process, not the user's TUI [UNVERIFIED in docs].
- Verdict: no native idle wake. Use the terminal fallback (section 4) or none.

**Qwen Code. It has a native, documented injection path.** https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/commands.md
section 6, "Messaging Another Running Session": "The feature is **on by default**."
- "A session exports its own inbox address and a token to child processes as `QWEN_CODE_MESSAGING_SOCKET` and
  `QWEN_CODE_MESSAGING_TOKEN`, so a script or hook the session runs can send a message back into it." Frames are JSON
  lines over a Unix socket: an `auth` frame, then a `user` frame with a fresh `msgId`.
- Own-process messages are "delivered without review" under the default mode-parity rule. The model sees
  `<cross_session_message origin="own-process">`.
- External daemons can use `qwen sessions controllers add --label khala` to mint a token, then connect to `ipcPath` from
  `qwen sessions ps --json`. The protocol contract is
  https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/cross-session-protocol.md, and
  `@qwen-code/sdk/peer` implements it.
- Delivery timing: protocol doc says "today the receiver queues both for the next turn". Open PR #13428 says "every
  accepted message from another Qwen Code session is parked until that session is idle". That an idle TUI then
  auto-starts a turn is strongly implied (the design doc's use case is "tell each other a build finished"), but it is
  [UNVERIFIED live]. Messages from the user's own process go through `send_message`-style flood limits (50 queued).
- `khala mcp` is a child of the qwen process and inherits these variables [UNVERIFIED]. It can inject directly.
  Users can disable the feature with `agents.crossSessionMessaging: false` or `crossSessionInbound: hold|refuse`.
- Qwen hooks: `"async": true` exists, but "Output is not delivered yet: systemMessage, additionalContext and plain stdout
  from an async hook are neither shown to the user nor added to the model context" (qwen hooks docs). There is no
  asyncRewake. Stop `decision:"block"` has `stop_hook_active` and `stopHookBlockingCap` (default 8).

## 4. Terminal remote control (last-rung fallback)
These tools write into a specific pane through the terminal's own IPC. No focus change, no OS keystroke API.
| Terminal | Detect (env in hook process) | Deliver | Source quote |
|---|---|---|---|
| tmux | `$TMUX`, `$TMUX_PANE` | `tmux send-keys -t $TMUX_PANE -l "<text>"` then `Enter`; or `load-buffer` + `paste-buffer -p -t` | man tmux: "The pane ID is passed to the child process of the pane in the TMUX_PANE environment variable"; "-p ... paste bracket control codes are inserted ... if the application has requested bracketed paste mode" |
| kitty | `$KITTY_WINDOW_ID`, `$KITTY_LISTEN_ON` | `kitten @ --to $KITTY_LISTEN_ON send-text --match id:$KITTY_WINDOW_ID --bracketed-paste ...` | sw.kovidgoyal.net/kitty/remote-control: needs `allow_remote_control` / `remote_control_password` in kitty.conf (one-time config; off unless set) |
| WezTerm | `$WEZTERM_PANE` | `wezterm cli send-text --pane-id $WEZTERM_PANE` (bracketed by default; `--no-paste` to type) | wezterm.org/cli/cli/send-text: "Send text to a pane as though it were pasted" |
| iTerm2 | `$ITERM_SESSION_ID` (`w0t0p0:<UUID>`, UUID = session id [UNVERIFIED format]) | Python API `app.get_session_by_id(id)` then `session.async_send_text(text, suppress_broadcast=True)` | iterm2.com/python-api: "Send text as though the user had typed it"; needs the Python API enabled (one-time) |
- Mapping a session to its pane: capture the variables in a SessionStart hook, which runs as a child of the agent in
  the pane, and write `pane.json` beside `activity.json` in the per-session state dir. Do not rely on the MCP server's
  env, because Codex strips it. Verify that the pane still holds the agent: tmux `#{pane_pid}` is an ancestor of the
  agent pid, and kitty `ls` shows the window's foreground process.
- Typing risks: a half-typed draft concatenates with injected text and Enter submits both; tmux copy-mode
  (`#{pane_in_mode}`) or `#{pane_input_off}` swallows keys; bracketed paste of a newline does not submit, so send Enter
  separately; synchronised panes broadcast; a pane re-used after the agent exits gets the text in a shell
  (command-injection risk), so send only a fixed literal ("Khala: messages waiting. Continue."), never channel text.
- Mitigations: inject only when `activity.json` has been idle for N seconds; skip when tmux `#{client_activity}` is
  recent [heuristic] or the pane is in a mode; one nudge per unread batch; opt-in per user (`wake.terminal=on`).
- None of this works on Windows Terminal, plain GNOME Terminal or Alacritty. There is no remote-control API there, so
  the result is "no idle wake".

## 5. Recommendation per harness
| Harness | Primary (confidence) | Fallback (confidence) |
|---|---|---|
| Claude Code | asyncRewake Stop watcher with the 3000s deadline removed or raised to about 24h, keeping the parent-alive and nonce checks. Optionally add a SessionStart asyncRewake watcher gated to the interactive TUI (high: docs say the timeout is unenforced on Stop; live long-idle test still owed) | `--channels` for users who already use it (medium, research preview, violates the launch rule for everyone else); terminal nudge (medium) |
| Codex | `codex queue --thread <id>` through the shared daemon, as today, with a version gate and a live CI check (medium: shipped and merged, but undocumented and `#[experimental]` API; dead with `--no-daemon`) | terminal nudge via a SessionStart-captured pane (medium). App-server `turn/start` on the daemon socket only if `queue` regresses (low) |
| Qwen Code | Native session inbox: `khala mcp` (or the hook) writes an auth + `user` frame to `$QWEN_CODE_MESSAGING_SOCKET` with the child token; daemon variant via `qwen sessions controllers` (medium-high: documented and on by default; idle auto-turn and MCP env inheritance need a live test) | terminal nudge (medium) |
| Gemini CLI | Terminal nudge, opt-in, tmux/kitty/WezTerm/iTerm2 only (medium where available; none elsewhere) | No idle wake; deliver at the next BeforeAgent/AfterTool. Optional bounded AfterAgent linger (low: holds the turn open, model cost) |
