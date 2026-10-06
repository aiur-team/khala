# Spike U40 (MH-U40, #1126): Qwen and Muse no-gap wake

The Executor ran this on 2026-10-05, 23:37–23:57 PDT, on Linux (Arch, kernel 7.1.4). Plan unit U40 of
`docs/plans/2026-10-05-001-feat-multi-harness-parity-plan.md` (plan commit `6e573947`). It builds on
[`qwen.md`](qwen.md) (U30, #1116) and [`muse.md`](muse.md) (U32, #1117). Where those settle a point, this doc cites them.

- **Qwen Code 0.25.0** (`@qwen-code/qwen-code`, npm `latest`), installed into an isolated prefix
  (`npm install --prefix /tmp/claude-1000/s1126/qnpm`). Model: DeepSeek V4 Flash (`deepseek-v4-flash`). The key was
  passed only as `DEEPSEEK_API_KEY` in the launch environment, referenced by `envKey`.
- **Muse Code 1.4.3 (1.4.3-R5018.1)**, run directly as `~/.local/bin/muse-bin-1.4.3-R5018.1` with
  `MUSE_NO_AUTO_UPDATE=1`. Model: `muse-spark-1.3` at `minimal` effort. The Windows build checked statically is
  `muse-x86-windows.exe` 1.4.3-R5018.1 (sha256 `dd510f81…e26b`, matches the public release manifest).
- **Isolation:** each harness had its own `HOME` and XDG dirs under `/tmp/claude-1000/s1126/`. The Muse `auth.json`
  was copied in read-only. TUIs ran in a private tmux server (`tmux -L spike-1126 -f /dev/null`, 200x50), driven only
  with `send-keys` and read with `capture-pane`. The server was killed afterwards. No real config file was written
  (the hashes of `~/.config/muse/*` were identical before and after). There is no `~/.qwen`.
- **Model usage.** Muse: 2 typed prompts and 3 woken turns, plus Muse's own reminder subagents. Qwen: 3 typed
  prompts (one was blocked by the Auto-mode classifier) and 5 woken turns, plus Qwen's background suggestion and memory
  calls.

## Results

The ticket's criteria:

| # | Criterion | Result | One-line evidence |
|---|---|---|---|
| 1 | **Qwen on Windows:** messaging-socket transport, and whether `auth` + `user` starts an idle turn | **FAIL** (static, from source) | There is no transport. Automatic inbox paths are filesystem sockets, and on `win32` `bindAt` returns `unsupported_platform` ("automatic peer inbox paths are not supported on Windows"), so cross-session messaging is **off**. The TUI passes no pipe path, and no setting overrides it. Replacement: E7 below |
| 2a | **Qwen `crossSessionInbound: hold`:** a held message starts a turn once the session is idle | **FAIL** | Receipt `held`, the TUI shows "1 waiting — /peers to review", and no turn ran in 25 s of idle. This holds for a **controller** sender too: the `hold` setting wins. Only `/peers accept` releases it (U30 C4) |
| 2b | **Qwen controller token** minted with `qwen sessions controllers add --label khala` makes delivery independent of the own-process path | **PASS** | The token was minted while the TUI was already running. An **unrelated** process (not a Qwen child) sent `auth{qpc_…}` + `user`. Receipt `delivered` came in 0.03 s, the turn started, and the model replied `EGRET QW-CTRL-5e07`. The model sees `origin="controller" controller="khala"`, with user-equivalent authority |
| 3 | **Muse peer approval:** persists across sessions, and the install step can record it | **FAIL** | Not reachable. External ingress is closed even from a process **inside** the Muse session tree (`khala mcp`, with `MUSE_SESSION_ID`): `external_agent_ingress_closed`. The binary has no settings key or CLI command for peer approval (`allow_connected` is a per-connection decision). Not needed: E1 |
| 4 | **Muse on Windows:** session messaging exists in the current Windows build | **PASS** (static) | The Windows 1.4.3-R5018.1 binary contains `List or send cross-session messages`, the `send_session_message` and `list_peer_sessions` tools, the `local_session_messaging` gate, and the same `external_agent_ingress` gate. It runs over named pipes (`NtCreateNamedPipeFile`, `\Device\NamedPipe\`). The `monitor` tool and its idle wake are present too |

What the caller asked for (KD1-clean idle wake):

| # | Probe | Result | One-line evidence |
|---|---|---|---|
| E1 | **Muse: an agent-armed `monitor` on a watcher command wakes an idle session** | **PASS** | Each stdout line becomes an `inbox_item_queued` (`source: monitor_event`), and with `wake_delay_ms: 0` a run starts **0.2 s** later with no keypress. The model answered `MON-WAKE-77d2`. A draft in the composer was left intact. `persistent: true` runs until session end |
| E2 | Muse: `muse session-message send` from `khala mcp` (a Muse child) to its own session | **FAIL** | `{"status":"unavailable","error_code":"external_agent_ingress_closed"}` for both `list` and `send` |
| E3 | Muse: a native async or rewake hook | **FAIL** (absent) | The only hook-wake string is the plugin-compat diagnostic `rewakeMessage … Muse does not wake the model from a hook`. No hook option starts a turn (also U32 item 6) |
| E4 | Muse: a Muse-to-Muse relay peer | **Not pursued live** | Native peer wake works (U32 item 7). But a relay means Khala launching a Muse agent, which KD1 forbids, and every relay costs a model turn. E1 makes it unnecessary |
| E5 | Qwen: a rendered Khala frame through the socket makes the woken model act and reply | **PASS** (once the user has joined in-session) | Cold, with no channel context in the session, the model refused, as it did in U30. After the user's typed "I've joined this session to my Khala channel #spike…", the next frame woke a turn in which the model called `khala_send {"text":"OSPREY QW-FRAME-c3a8"}`. It failed only with `not_connected`, because the spike had no stack |
| E6 | Qwen: a hook can verify the woken frame's nonce | **PASS** (via `Stop` + `transcript_path`) | `UserPromptSubmit` still does not fire on woken turns (re-confirmed). `Stop` fires, and its payload carries `transcript_path`. That transcript records the woken message (`type: user`, `provenance: system`, `subtype: notification`, `deliveredTurn: true`) with the nonce inside `<cross_session_message …>` |
| E7 | Qwen: an agent-armed background shell wakes an idle session (works without the socket) | **PASS** | `run_shell_command` `is_background: true` on the watcher. When it exited, "Background shell … completed" appeared and a turn ran **~1.3 s** after the trigger. The model replied `PLOVER — QW-BG-61f3`. This also worked with `crossSessionInbound: hold` set. It needs a `permissions.allow` rule: Auto mode's classifier blocked the first attempt |

**No KD5/KTD18 hard blocker.** Every cell has a KD1-clean idle-wake mechanism. The user starts the harness as usual,
the agent arms the watcher itself (the Claude `khala watch` pattern), there is no keystroke injection, and the
composer is not touched:

- **Muse:** the `monitor` tool (E1) on all platforms. The tool and its idle wake are in the Windows build too.
- **Qwen on Linux and macOS:** the socket (U30), preferably with a controller token (2b), with the background shell
  (E7) as a fallback.
- **Qwen on Windows:** the background shell (E7). The socket is off there (1).

Two points are left for the operator, not decided here:

- **Windows live runs are still unverified.** Criteria 1 and 4 are source/strings results. Neither the Qwen nor the
  Muse Windows path was run live, because there is no Windows machine. U36 should run them.
- **Qwen `hold` is a user opt-out of socket wakes.** E7 still wakes under `hold`, because it is the agent's own
  command, not a cross-session message. U31 should decide whether Khala uses E7 when the user has set `hold`, or
  honours `hold` and delivers at the next hook instead.

## Evidence

### Muse

#### E1: `monitor` idle wake

The tool list (from the binary) is `read_file search edit_file write_file apply_patch read_memory add_memory edit_memory
shell monitor bash_input work_stop send_session_message list_peer_sessions web_fetch web_search subagent_* cron_*
create_goal update_goal report_progress`. The account's fetched gates include `"monitor": true`. The `monitor` tool
description (verbatim excerpts) says:

> Sources: a shell command (each stdout line is an event; exit ends the watch) or a WebSocket. … After start, keep
> working; events arrive automatically as machine notifications, not user replies. Stop with work_stop. Timed ceiling:
> 30 minutes; persistent runs until work_stop or session end.

Its arguments (`MonitorStartArgs`) are `command|ws, ws_subprotocols, timeout_ms, persistent, wake_delay_ms, show_lines`.
Two of them matter here:

- `wake_delay_ms`: "How long ordinary output may batch before waking an idle run. 0 = immediate; otherwise at least 1000."
- `show_lines`: "each line gets its own transcript cell. Set for a chat/connector listener, not a build log."

The stand-in for `khala watch` was `watch.sh <name> loop`, which prints one line per trigger file.

Run 1 used the defaults. Typed prompt: "Start a monitor (the monitor tool) on the command `…/watch.sh mon loop`. Each
line it prints is a new Khala channel message for you; when one arrives, reply with the nonce it contains…".

```
tool call   monitor {"command":"/tmp/claude-1000/s1126/watch.sh mon loop","description":"Watch Khala channel messages"}
policy      side_effect_intent operation=tool:monitor policy_decision=allow:policy     (no approval prompt)
result      {"timeout_ms":300000,"persistent":false,"message":"Monitor started (… timeout 5m). Events will be delivered automatically. …"}
1791268728.64  trigger written (TUI idle)
1791268729.60  inbox_item_queued {source: monitor_event, event_kind: stdout_line, disposition: queue}   footer: "watching · 1 queued"
1791268849.61  run started (prompt "", run_origin client_id "muse-runtime-background-terminal")       <- +120 s: the default batch delay
1791268852.33  assistant: "MON-WAKE-3c91"
```

Run 2: the model was asked to `work_stop` that monitor and restart it with `persistent: true, wake_delay_ms: 0,
show_lines: true`, and it did. The call it made:

```
monitor {"command":"/tmp/claude-1000/s1126/watch.sh mon2 loop","description":"Watch Khala channel messages","persistent":true,"show_lines":true,"wake_delay_ms":0}
1791268889.66  trigger written (TUI idle; watch.sh polls every 1 s)
1791268890.33  inbox_item_queued
1791268890.53  run started                      <- +0.2 s after the line, no keypress
1791268893.19  assistant: "MON-WAKE-77d2"
```

Run 3: the same as run 2, but with `half typed draft xyz` typed (not submitted) in the composer before the trigger. The
item was queued at 1791268968.53 and the run started at 1791268968.73, with the reply `MON-WAKE-d4e0`. After the turn
the composer still read `❯ half typed draft xyz`.

Hooks on the woken turns: `Stop` fired every time. `UserPromptSubmit` did **not** fire (it fired only for the two typed
prompts), the same as Qwen. Khala's `Stop` `decision: "block"` delivery (U32 item 3) therefore works on a
monitor-woken turn.

**Re-arming after a restart:** a `SessionStart` hook returning `hookSpecificOutput.additionalContext` reached the
model (`muse exec --provider echo`, which makes no model call):

```
hook_run_terminal {event: SessionStart, effects: ["context"], status: completed}
context_block_updated {lifecycle: session_start, role: developer, source: runtime_hook,
  text: "[khala] SS-CTX-5b10: you are joined to a Khala channel; start a persistent monitor on khala watch."}
```

#### E2: session messaging from inside the Muse process tree

`mcp2.py` was a stdio MCP server spawned by Muse, with `MUSE_SESSION_ID=01a10fee-…` in its env. When a trigger file
appeared it ran `muse session-message list --json` and then `send --target <own session id> --json` (body on stdin):

```
list -> rc=1 {"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed"}
send -> rc=1 {"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed","receipts":[]}
```

Being a child of the target session does not help. Without the `external_agent_ingress` gate, every non-model sender is
refused (U32 item 5).

#### E3 and criterion 3: hook rewake and peer approval

- **Hook wake:** the only hook-wake strings are the plugin-compat diagnostic (`rewakeMessage`, `rewakeSummary`,
  `Muse does not wake the model from a hook`). There is no hook option that starts a turn.
- **Peer admission causes:** `allow_once | reject_once | allow_connected | block_connected | exact_profile_match |
  authenticated_controller | authenticated_external_agent`. `session controller authentication is unavailable` is
  also present. No settings key or CLI subcommand records a peer grant.

#### Criterion 4: Windows build

String counts, Windows `muse-x86-windows.exe` vs Linux:

```
session-message          win=19 linux=46     send_session_message   win=36 linux=37
local_session_messaging  win=28 linux=32     external_agent_ingress win=2  linux=6
"List or send cross-session messages"  win=1 linux=1
"Monitor is for repeated events"       win=2 linux=2
"How long ordinary output may batch before waking an idle run"  win=1 linux=1
"wakes you even after you end the turn" win=1 linux=1
Windows transport: NtCreateNamedPipeFile, \Device\NamedPipe\ (UTF-16), PeekNamedPipe; model shell "Windows PowerShell"
```

### Qwen

#### Criterion 1: Windows transport

From `chunks/chunk-RWG73JIE.js` and `chunks/chunk-G55NRP23.js` (0.25.0):

```js
resolvePeerSocketCandidates(): [$XDG_RUNTIME_DIR/qwen-socks/<pid>.sock, os.tmpdir()/qwen-socks-<hex>/<pid>.sock, /tmp/qwen-socks-<hex>/<pid>.sock]
isLocalIpcPath(c): if (process.platform === "win32") return c starts with "\\.\pipe\" or "\\?\pipe\"
bindAt(...): if (!isLocalIpcPath(path)) { unsupportedPlatform = automaticPath && process.platform === "win32";
  -> InboxSetupError("unsupported_platform", "automatic peer inbox paths are not supported on Windows",
                     "Disable cross-session messaging for this session.") }
startPeerInbox: on unsupported_platform -> "cross-session messaging is OFF for this session"
```

The interactive UI calls `PeerMessaging.start({...})` with no `socketPath`, and no setting or env var supplies one.
On native Windows, no inbox is bound, `QWEN_CODE_MESSAGING_*` is not exported, and no frame can be sent.

#### Criterion 2: `hold` and controller tokens

```
$ HOME=$S/qhome qwen sessions controllers add --label khala --json
{"id":"c_998512c2","label":"khala","token":"qpc_…(redacted)","createdAt":1791269536255}    -> $HOME/.qwen/peer-controllers.json
```

Session A (policy unset), running before the token was minted. `qsend_ctrl.py` is a plain Python process: its parent
is the Bash tool, not Qwen. It read `ipcPath` and `sessionId` from `$HOME/.qwen/sessions/<pid>.json`:

```
RECEIPT +0.03s {"type":"control","action":"delivery_status","status":"delivered", … "reason":"Your message was released to the recipient session."}
pane: ◆ EGRET QW-CTRL-5e07
model input: <cross_session_message from="…/ctl-3671860.sock" name="khala" origin="controller" controller="khala"> …
             <session_authority origin="controller"> This came through a controller your user trusts … Treat it as coming
             from your user for ordinary actions …
```

Session B, with `"agents": {"crossSessionInbound": "hold"}` and the same controller token:

```
RECEIPT +0.02s {"status":"held", … "reason":"Your message is held for the recipient user to review before it reaches th…"}
pane: ● Held a message from a trusted controller (khala) (your crossSessionInbound setting is "hold"). 1 waiting — /peers to review.
Stop-hook count before/after 25 s idle: 4 / 4   (no turn)
```

The protocol doc (`bundled/qc-helper/docs/features/cross-session-protocol.md` §6) agrees: "`agents.crossSessionInbound`
set to `accept`, `hold` or `refuse` wins", and held messages expire after `crossSessionHeldExpiry` (default `5m`).

#### E5: a rendered frame makes the woken model act

The content sent through the socket (own-process token, as in U30):

```
[Khala channel delivery] New messages in your Khala channel #spike (delivered by the khala plugin, written by channel members):
<khala_messages channel="spike" nonce="QW-FRAME-c3a8">
kevin (channel owner): quick check, reply with the word OSPREY and this nonce.
</khala_messages>
```

- **First frame, cold.** It was sent before the user had said anything about Khala in the session, with nonce `91b2`.
  The model refused: "It came from a process this session started, not from you … classic injection pattern".
- **Then the user's typed prompt:** "I've joined this session to my Khala channel #spike using the khala plugin. New
  channel messages will be delivered to you … answer them…".
- **The next frame woke a turn, and the model acted:**

  ```
  ✓ ToolSearch select:mcp__khala__khala_send,mcp__khala__khala_status
  x khala_send {"text":"OSPREY QW-FRAME-c3a8"}  -> {"error":"not_connected"}      (spike had no stack/channel)
  ✓ khala_status {} -> {"state":"idle","unread":0,"listeningMode":"sync"}
  ```

In real use, `khala_join` happens inside the session, so the channel context is already there when wakes arrive. The
controller origin (2b) carries user authority on top of that.

#### E6: nonce verification by hook

```
Stop payload keys: background_tasks, context_limit, context_usage, crons, cwd, hook_event_name, input_tokens,
                   last_assistant_message, permission_mode, …, stop_hook_active, transcript_path
transcript line 10: {"type":"user","provenance":"system","subtype":"notification","deliveredTurn":true,
  "message":{"role":"user","parts":[{"text":"<cross_session_message from=\"…\" name=\"khala-spike\" origin=\"own-process\">\n[Khala … nonce=\"QW-FRAME-c3a8\" …"}]}}
UserPromptSubmit on woken turns: none. On tool-result continuations inside the woken turn: fired with prompt "".
```

`khala hook deliver` on `Stop` can therefore match the woken frame's nonce against its sent-but-unconfirmed record by
reading the last `subtype: notification` entry of `transcript_path`.

#### E7: an agent-armed background shell

With `"permissions": {"allow": ["Bash(/tmp/claude-1000/s1126/watch.sh *)"]}` and the session still under
`crossSessionInbound: hold`, the typed prompt was: "Run `…/watch.sh qbg` with run_shell_command and is_background:
true. It is my Khala channel watcher: when it exits, its output is a new message …".

```
✓ Shell /tmp/claude-1000/s1126/watch.sh qbg [background]   Background shell bg_c4f6b71f started (pid 3725189).
1791269691.78  trigger written (idle)
1791269693.09  Stop hook (woken turn finished)
pane: ● Background shell "/tmp/claude-1000/s1126/watch.sh qbg" completed.
      ◆ PLOVER — QW-BG-61f3
```

Without the allow rule, Auto mode's classifier blocked the same call ("I won't route around that block"). The `monitor`
tool also exists in Qwen, but its silence timeout is capped at 10 minutes (`MAX_IDLE_TIMEOUT_MS=6e5`). A watcher that
**exits** on a message (`is_background`) fits better. The background-shell code has no `win32` gate. Qwen's sub-agent
executors do: they are documented as rejected on native Windows, and that does not apply here.

## Consequences for dependent units

- **U43 (#1154), build what passes:**
  - **Muse wake rung 1 = agent-armed `monitor`**:
    `monitor {command: "khala watch --harness muse --session <MUSE_SESSION_ID>", persistent: true, wake_delay_ms: 0, show_lines: true}`.
    - `khala watch` must print one sparse line per delivery: a channel notice, not raw content. It should stay
      running (`loop`), because exiting ends the watch.
    - The `khala_join` tool result and the skill tell the agent to arm it. A `SessionStart` hook
      (`hookSpecificOutput.additionalContext`) tells it to re-arm after a restart or resume.
    - The woken turn fires `Stop`, so frame delivery uses the `Stop` `decision: "block"` path, gated on
      `stop_hook_active`.
    - The terminal rung (U32's fallback) is no longer the primary Muse wake.
  - **Qwen:**
    - Mint a controller token at install (`qwen sessions controllers add --label khala --json`), store it `0600` in
      Khala state, and wake through the socket with `origin=controller`.
    - Send the **rendered frame** as content (E5). Verify the nonce from `Stop` + `transcript_path` (E6).
    - On Windows, where the socket is off (1), and as a fallback anywhere, use E7: the agent runs `khala watch` with
      `run_shell_command` `is_background: true`, it exits on the first delivery, and the agent re-arms. The installer
      must add `permissions.allow: ["Bash(khala watch*)"]`, or Auto mode may block it.
- **U31 (#1142), Qwen adapter:** adopt the controller token over the own-process token. Surface `held` in `khala status`.
  Decide whether E7 runs under `hold` (see above).
- **U33 (#1143), Muse adapter:**
  - Register `wake: monitor` (not peer messaging). Drop the peer-approval install step: no setting exists, and none is
    needed.
  - The `monitor` start is auto-allowed in the default (Auto-review) mode. U36 should check a stricter permission
    profile.
- **U36 (#1158), live matrix:**
  - Add Windows rows: the Muse `monitor` wake and the Qwen `is_background` wake.
  - Add a row: Muse wake latency with `wake_delay_ms: 0`.
  - Add a row: a Qwen woken agent posts in the channel after a real `khala_join` (E5 stopped at `not_connected`).
- **HB3 (Muse on Windows, per-session peer approval):** resolved by moving off peer messaging. The remaining risk is
  only the live Windows confirmation in U36.

## Operator notes

- Muse again added name claims to `~/.local/share/muse/session-name-authority/session-names.db` under the **real**
  home (modified 23:43). This is the known U32 side effect: it is runtime state, not config, and was left as is.
- Scratch scripts and logs are in `/tmp/claude-1000/s1126/` (`mcp2.py`, `watch.sh`, `qsend_ctrl.py`, `mev.py`). The
  controller token exists only in the isolated `qhome`.
