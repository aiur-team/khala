# Spike U38 (MH-U38, #1118): no-gap wake in terminal hosts; empty-prompt patterns

The Executor ran this on 2026-10-05, 21:38–21:55 PDT, on Linux (Arch, kernel 7.1.4, Hyprland). Plan unit U38 of
`docs/plans/2026-10-05-001-feat-multi-harness-parity-plan.md` (plan commit `6e573947`).

- **Terminals on this machine:** tmux 3.7b and Alacritty 0.17.0 (94e7c887). kitty, WezTerm, GNOME Terminal, VS Code,
  Cursor, Windows Terminal and Terminal.app are not installed. Nothing was installed for this spike, and no GUI window
  was opened.
- **Harnesses** (versions as run):

  | Harness | Version | Model used for wake turns |
  |---|---|---|
  | Claude Code | 2.1.290 | Haiku 4.5 |
  | Codex | codex-cli 0.160.0 | default (GPT-6.1-Sol) |
  | Gemini CLI | 0.62.0. 0.61.0 was installed, and it updated itself on first launch | placeholder API key, so no model call ran (see C1) |
  | OpenCode | 1.15.6 | default (DeepSeek V4 Pro) |
  | Copilot CLI | 1.0.92 | default (GPT-5.6 Terra) |
  | Antigravity CLI (`agy`) | 1.2.17. 1.2.13 was installed, and it updated itself on first launch | Gemini 3.8 Flash |
  | Muse Code | 1.4.3-R5018.1 | default (muse-spark-1.3-contributor) |
  | Qwen Code | not installed | none |

- **Isolation:** every TUI ran with `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`
  pointing into `/tmp/claude-1000/spike-1118/home`. Auth files were copied in from the real home, and the real
  config files were only read. Copilot CLI read its token from the keyring. Each TUI ran in a window of a private,
  detached tmux server (`tmux -L spike-1118 -f /dev/null`, 200x50). The server was driven only with `send-keys` and
  read with `capture-pane`, and it was killed afterwards. Each wake test read `hyprctl activewindow` (a query, not a
  dispatch) before and after the send.
- **Model usage:** one `Reply with only the word ok.` turn per harness, plus repeat turns for the Enter-delay check
  (Codex, Gemini, Muse) and five Haiku turns for C6.

## Results

| # | Criterion | Result |
|---|---|---|
| 1 | Empty-prompt patterns: capture each idle input line empty and with a typed draft, and write one regex per harness that matches only the empty line | **PASS** for Claude Code, Codex, Gemini CLI, Antigravity CLI, Copilot CLI, Muse Code and OpenCode. 31 of 31 captures are classified correctly by `terminal-hosts/verify.py`. **Qwen Code: UNTESTED**, because it is not installed |
| 2 | Editor-integrated terminals (VS Code, Cursor): find the agent's terminal from a throwaway extension, read its input line, and `sendText` without `show()`, both unfocused and focused-and-typing | **UNTESTED**: VS Code and Cursor are not installed, and this spike may not open GUI windows |
| 3 | Windows Terminal and conhost (Gemini CLI, Copilot CLI, Claude Code): is there documented IPC that writes to a pane's input without keystroke injection? | **UNTESTED**: no Windows machine |
| 4a | Alacritty (Linux): the same question | **FAIL**. Alacritty's only IPC, `alacritty msg`, offers `create-window`, `config` and `get-config`, and none of them writes to a pane's input |
| 4b | GNOME Terminal (Linux) | **UNTESTED**: not installed |
| 4c | Terminal.app (macOS) | **UNTESTED**: no macOS machine |
| 5a | Gemini CLI releases after v0.62.0: any injection API into the running TUI? | **FAIL**. No stable release exists after v0.62.0. The notes for v0.63.0-preview.0 and the v0.64.0 nightlies up to 20261006 add no IPC, socket, remote or attach path. The only inbound channel, the IDE companion, carries four notifications, and none starts a turn |
| 5b | Antigravity CLI (with U28 item 4): any injection API into the running TUI? | **FAIL as a KD1-clean path**. A native injection path exists, Remote Control, but it starts only with the `--remote-control` launch flag or the `/remote-control` slash command. A local, CSRF-gated language server is a lead handed to U28 |
| 6 | Claude Code: can a `--continue` or `--resume` session be woken by any native path before its first Stop? | **PASS** in the interactive TUI. A `SessionStart` hook with `asyncRewake: true` woke fresh, `--continue` and `--resume` sessions before their first Stop, and it did not delay the user's first reply |

A tmux check ran alongside criterion 1. A U14-style `send-keys` wake started a turn in all seven installed TUIs
without moving OS focus. Codex, Gemini CLI and Muse Code need a pause before Enter, as described below.

Criteria 2, 3, 4b, 4c and the Qwen Code part of 1 stay open until the operator runs them (see the last section).

## Evidence

### C1: empty-prompt patterns (PASS for seven harnesses)

**Method.** Each harness was started in its own tmux window and taken through its folder-trust dialog. Gemini also
needed `security.auth.selectedType: gemini-api-key` and a placeholder `GEMINI_API_KEY`, because its consumer OAuth
login now fails with "This client is no longer supported for Gemini Code Assist for individuals … migrate to the
Antigravity suite". The input line looks the same either way.

For each harness, `capture.sh` saved:
- the full pane, as plain text and with `-e` (SGR attributes);
- `#{cursor_x}` and `#{cursor_y}`, and the cursor line itself.

It saved these states:
- `empty`: the TUI just reached idle;
- `draft`: `draft text` typed and not sent;
- `space`: a single space typed;
- `after-turn`: idle again after one wake turn;
- Claude only: `draft-home`, where `abc` was typed and then Home pressed, and `empty-rotated`, a fresh session with a
  different placeholder;
- OpenCode only: `draft-session`, a draft in the in-session layout.

All captures are in `terminal-hosts/`. `python3 docs/build/multi-harness/spikes/terminal-hosts/verify.py` checks
each pattern against them and prints `FAILURES: 0`.

**The guard.** Read the cursor line with `capture-pane -p -t <pane> -S <cursor_y> -E <cursor_y>` and strip trailing
ASCII spaces only. The line counts as empty when both of these hold:
1. it matches the regex;
2. `cursor_x` equals the input column.

The cursor check is required. In five harnesses a whitespace-only draft looks exactly like an empty prompt, and only
the cursor position tells them apart.

| Harness | `emptyPrompt` regex (cursor line) | Input column (`cursor_x`) | Placeholder when empty |
|---|---|---|---|
| Claude Code | `^❯[  ]?(Try ".*")?$` | 2 | Dim (SGR 2) `Try "<example>"`, rotating over 8 templates; none after a turn |
| Codex | `^› ?(Ask Codex to do anything)?$` | 2 | Dim `Ask Codex to do anything`, the only placeholder in the 0.160.0 binary; shown after turns too |
| Gemini CLI | `^ > {3}Type your message or @path/to/file$\|^ > $` | 3 | Grey (fg 175,175,175) `Type your message or @path/to/file` after an inverse-video block cursor |
| OpenCode | `^ *┃ *(Ask anything\.\.\. ".*")?$` | column of `┃` + 3 (66 on the home screen, 5 in a session) | Grey `Ask anything... "<example>"`, rotating, on the home screen; none in a session |
| Copilot CLI | `^❯ ?$` | 2 | none |
| Antigravity CLI | `^> ?$` | 2 | none |
| Muse Code | `^❯ ?$` | 2 | none |
| Qwen Code | UNTESTED | none | none |

Captured cursor lines (`cursor_x`, then the plain cursor line, trailing spaces trimmed):

```
claude   empty         x=2   ❯ Try "edit <filepath> to..."     (SGR: ❯ NBSP ESC[2mTry ... ESC[0m)
claude   empty-rotated x=2   ❯ Try "how do I log an error?"
claude   draft         x=12  ❯ draft text
claude   draft-home    x=2   ❯ abc
claude   space         x=3   ❯
claude   after-turn    x=2   ❯
codex    empty         x=2   › Ask Codex to do anything        (SGR: ESC[1m›ESC[0m ESC[2mAsk Codex…ESC[0m)
codex    draft         x=12  › draft text
codex    space         x=3   ›
codex    after-turn    x=2   › Ask Codex to do anything
gemini   empty         x=3    >   Type your message or @path/to/file
gemini   draft         x=13   > draft text
gemini   space         x=4    >
gemini   after-turn    x=3    >   Type your message or @path/to/file
opencode empty         x=66  ┃  Ask anything... "Fix broken tests"   (home screen, ┃ at column 63)
opencode draft         x=76  ┃  draft text
opencode space         x=67  ┃
opencode after-turn    x=5   ┃                                      (session layout, ┃ at column 2)
opencode draft-session x=15  ┃  draft text
copilot  empty         x=2   ❯
copilot  draft         x=12  ❯ draft text
copilot  space         x=3   ❯
copilot  after-turn    x=2   ❯
agy      empty         x=2   >
agy      draft         x=12  > draft text
agy      space         x=3   >
agy      after-turn    x=2   >
muse     empty         x=2   ❯
muse     draft         x=12  ❯ draft text
muse     space         x=3   ❯
muse     after-turn    x=2   ❯
```

**Notes for U14 and the adapter units:**
- **Claude Code puts U+00A0 (no-break space) after `❯`**, not U+0020. A guard that uses `\s` without the `u` flag, or
  the literal pattern `^❯ `, never matches. JavaScript's `trimEnd()` strips U+00A0, which is why the regex accepts
  both. This first broke the live wake test: the guard skipped until the pattern allowed NBSP.
- **Placeholders are visible text.** Claude, Codex, Gemini and OpenCode draw placeholder text on the empty line, so a
  plain `capture-pane -p` shows a non-empty line. The regexes list the placeholder forms. Claude builds its
  placeholder as `Try "${h[...]}"` over eight templates (`fix lint errors`, `fix typecheck errors`,
  `how does <file> work?`, `refactor <file>`, `how do I log an error?`, `edit <file> to...`,
  `write a test for <file>`, `create a util logging.py that...`), so the pattern accepts any `Try "…"`.

  A draft that copies a placeholder exactly, with the cursor moved to the input column, would still pass. To close
  that, read the line with `capture-pane -e` and require the text after the marker to be dim (`ESC[2m`). That works
  for Claude and Codex. Gemini (grey 175) and OpenCode (grey 128) use theme colours rather than SGR 2.
- **Whitespace-only drafts.** In Claude, Copilot, agy, Muse and OpenCode, a draft of one space renders exactly like an
  empty prompt. Only `cursor_x` (input column + 1) tells them apart.
- **Read only the cursor line.** Transcript lines reuse the prompt glyph. Examples: `❯ Reply with only the word ok.`
  (Claude, Copilot, Muse), `› …` (Codex), `> …` (agy) and `┃  …` (OpenCode). Trust dialogs use it too:
  `❯ 1. Yes` (Copilot), `› 1. Trust and continue` (Codex) and `> Yes, I trust this folder` (agy). The patterns reject
  these because text follows the glyph, but a search over the whole screen would find false matches.
- **OpenCode has two layouts.** The home screen centres the input box, and in a session it sits at the bottom. The
  input column follows `┃`.

### tmux host check (supports C1 and HB1)

`wake.sh` does what U14 specifies:
1. checks that `#{pane_in_mode} #{pane_input_off}` is `0 0`;
2. applies the guard;
3. runs `send-keys -l 'Reply with only the word ok.'`, then `send-keys Enter`;
4. polls the screen for a turn.

```
claude    guard empty → sent → "● ok"   (turn finished within the 15 s observation window)
codex     guard empty → sent → line left in composer + empty second line; NO turn
          second Enter → turn at 1 s → "• ok"
          retry with ENTER_DELAY=0.5 → turn marker after 0.6 s → "• ok"
gemini    guard empty → sent → line left in composer + empty second line; NO turn
          second Enter → turn (API_KEY_INVALID error, as expected with the placeholder key)
          retry with ENTER_DELAY=0.5 → submitted (error count 2 → 4)
opencode  guard empty → sent → turn marker after 0.2 s → "ok"
copilot   guard empty → sent → turn marker after 0.2 s → "● ok"
agy       guard empty → sent → turn marker after 0.1 s → "ok"
muse      guard empty → sent → line left in composer + empty second line; NO turn
          second Enter → "◆ ok"; retry with ENTER_DELAY=0.5 → "◆ ok"
claude    with "my draft" typed: guard → "GUARD: not empty, skip" (nothing sent)
hypr active window before/after every send: "address":"0x564e4fbf4ac0","class":"Alacritty" (unchanged)
```

- **Codex, Gemini CLI and Muse Code turn an Enter that arrives right after a `send-keys -l` burst into a newline.**
  This is paste-burst detection, and it leaves the fixed line in the user's composer. A 0.5 s pause before
  `send-keys Enter` fixed it in all three. Claude, OpenCode, Copilot and agy submitted with no pause. U14 should
  always wait about 0.5 s before Enter.

  The nonce check must also treat "text left in the composer" as a failure. Once the line wraps, the cursor sits on
  an empty second line, so the next guard read can pass and append to the stuck line.
- No tmux client was attached, so the wake moved neither OS focus nor any pane focus. The active Hyprland window was
  the same before and after every send.

### C2: editor-integrated terminals (UNTESTED)

VS Code and Cursor are not installed. Testing them needs a GUI window, which this spike's safety rules forbid. No
`experiments/terminal-hosts/` extension was written, because it could not be exercised here.

### C3: Windows Terminal and conhost (UNTESTED)

No Windows machine was available. The research (`idle-wake.md` §4) found no remote-control API for Windows Terminal.
Under KD1, `WriteConsoleInput` and `SendKeys` count as keystroke injection.

### C4: Alacritty, GNOME Terminal and Terminal.app

**Alacritty 0.17.0 (FAIL).** The only IPC is `alacritty msg` over `$ALACRITTY_SOCKET`. It does not open a window
unless asked to:

```
$ alacritty msg --help
Commands:
  create-window  Create a new window in the same Alacritty process
  config         Update the Alacritty configuration
  get-config     Read runtime Alacritty configuration
```

`config` can change keybindings at runtime, including a `chars` action that writes to the PTY. That still needs a
keypress, from the user or from injection, so it is not a wake.

**Linux, for any terminal.** Two lower-level routes were checked. Both are closed on this machine, and both would
count as input injection under KD1 anyway:
- **TIOCSTI** (push bytes into a tty's input queue): `dev.tty.legacy_tiocsti = 0`, and `CONFIG_LEGACY_TIOCSTI` is
  not set. Unprivileged processes cannot use it.
- **Taking the terminal's PTY master fd with `pidfd_getfd`**: `kernel.yama.ptrace_scope = 1`, which blocks it for
  non-descendant processes.

**GNOME Terminal (UNTESTED)** is not installed. **Terminal.app (UNTESTED)** needs macOS. Under KD1, `osascript` and
`xdotool` count as keystroke injection.

### C5: native surfaces

**Gemini CLI (FAIL).** These are the releases after v0.62.0 (REST `repos/google-gemini/gemini-cli/releases`):

```
v0.64.0-nightly.20261006.gfb972b2f8  2026-10-06  prerelease
v0.64.0-nightly.20261005 / 20261003 / 20261002 / 20261001 / 20260930  prerelease
v0.63.0-preview.0                    2026-09-29  prerelease
v0.63.0-nightly.20260929             prerelease
```

- **Release notes.** Searching the notes for ipc, socket, inject, remote, a2a, attach, listen, server, daemon, wake
  and idle found only unrelated fixes: `fix(core): remove invalid diff.external override`,
  `fix(acp): resolve session by exact id …` and `refactor(a2a-server): … settings migration`.
- **Open issues and PRs.** The same search over items updated since 2026-09-20 found nothing that injects into a
  running TUI. #29597 is about the IDE companion's IPC fallback inside sandboxes.
- **`gemini --help` (0.62.0).** It offers only `--acp`, which spawns a stdio session owned by its client.
- **The IDE companion channel.** This is the one inbound channel into a running CLI. The 0.62.0 bundle handles only
  `ide/contextUpdate`, `ide/diffAccepted`, `ide/diffClosed` and `ide/diffRejected`, and none of them starts a turn.

**Antigravity CLI 1.2.17 (FAIL as a KD1-clean path; leads for U28).**
- **Remote Control.** `agy changelog` says: "Added Remote Control (start a connection via `--remote-control` startup
  flag or `/remote-control` slash command) to create a session-scoped remote connection for following and
  controlling your active terminal session from another device". It also says: "Fixed turns triggered from a
  connected Remote Control session …".

  So agy has a native way to start a turn in a running TUI. But it needs a launch flag or an in-session slash command
  that the user runs, and its transport is a Google-hosted tunnel. `agy remote-control start|status|stop` registers a
  background daemon that keeps the machine reachable. Whether that daemon can attach to an already-running TUI
  session without `--remote-control` is for U28 item 4.
- **A local language server.** The running spike `agy` (pid 1648340, the tmux pane's child) listened on
  `127.0.0.1:43669` (HTTPS gRPC) and `127.0.0.1:41267` (HTTP). Its `cli-*.log` prints both ports: "Language server
  listening on random port at 41267 for HTTP". A request without a token returned
  `401 {"code":"unauthenticated","message":"missing CSRF token"}`.

  The binary contains `SendUserCascadeMessage` and `x-codeium-csrf-token`. Where a same-user process could get the
  CSRF token was not found: it is not in the process environment or in the log. This route would be undocumented, so
  it is a lead for U28, not a result.

### C6: Claude Code before its first Stop (PASS, interactive TUI)

The isolated `~/.claude/settings.json` had this hook:

```json
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command",
  "command":"sh -c 'date +%s.%N > …/ss-start; sleep 10; date +%s.%N > …/ss-exit; echo \"Spike wake test: reply with only the word woken.\" >&2; exit 2'",
  "asyncRewake":true,"timeout":120}]}]}}
```

```
claude --model haiku --continue    hook start 1791262161.887  exit 1791262171.889
  prompt idle and usable at +3.4 s while the hook ran; after exit: "● Stop hook feedback / ● woken"
claude --model haiku --resume 30f6a9f6-…   hook start 1791262198.321  exit 1791262208.323 → "● woken"
claude --model haiku (fresh)       hook start 1791262227.110  exit 1791262237.112 → "● woken"
```

Blocking check: the hook's sleep was raised to 40 s, a fresh session was started, and the user typed
`Reply with only the word hi.` 6 s after launch.

```
hook start 1791262258.593; user Enter 1791262264.535; "● hi" seen 3 s after Enter (hook still running)
hook exit 1791262298.595 → "● Stop hook feedback / ● woken"
```

In the interactive TUI, then, a pending `SessionStart` asyncRewake hook does not hold back the first reply. It still
wakes the session after an earlier user turn. This is the case the research had marked [UNVERIFIED live] (option 2 in
`idle-wake.md` §1).

The `-p`, SDK and desktop hosts were not tested here. Claude Code issue #89960 reports that the hook blocks the first
reply in those hosts, so the arm must stay gated to the interactive TUI. The wake is labelled "Stop hook feedback" in
the transcript. That label is cosmetic.

## Hard blocker HB1 (for the operator; not decided here)

KD5 and KTD18 say a cell with no KD1-clean wake is escalated, never accepted. The evidence by cell:

| Harness | tmux | Alacritty | GNOME Terminal | Terminal.app | Windows Terminal / conhost | Native, terminal-independent path |
|---|---|---|---|---|---|---|
| Gemini CLI | wake works (C1 check; 0.5 s Enter pause) | **no KD1-clean mechanism found** (C4a, C5a) | untested; research says no remote-control API | untested; research says none, `osascript` excluded | untested; research says none | **none** (C5a) |
| Antigravity CLI | wake works | **no KD1-clean mechanism found** (C4a); Remote Control needs a launch flag or slash command (C5b) | untested | untested | untested | Remote Control (UX change) and a CSRF-gated local LS (lead, U28) |
| Claude Code (fallback cells) | wake works | covered natively: Stop watcher plus the C6 SessionStart arm in the interactive TUI | same | same | same | **yes, in the interactive TUI** (C6). Not in `-p`, SDK or desktop |
| Codex (fallback cells) | wake works (0.5 s Enter pause) | covered by `codex queue` unless the TUI runs with `--no-daemon` | same | same | same | `codex queue` (U13); `--no-daemon` TUIs have none |
| Copilot CLI (fallback cells) | wake works | covered by the U23 extension `session.send` (PASS in `spikes/copilot.md`), if U25 ships | same | same | same | extension `session.send` (experimental flag) |
| OpenCode (fallback cells) | wake works | covered by plugin `promptAsync`, which passed U20(c) (`spikes/opencode.md`) | same | same | same | plugin `promptAsync` (U20) |
| Muse Code | wake works (0.5 s Enter pause) | depends on U32 and U40 | same | same | same | U32 and U40 |

What this spike adds to HB1:
1. **Confirmed on real hardware:** Gemini CLI 0.62.0 and Antigravity CLI 1.2.17 in Alacritty 0.17.0 have no wake that
   satisfies KD1. Alacritty has no input-writing IPC, Linux blocks TIOCSTI and cross-process PTY fd capture, Gemini
   has no injection API, and Antigravity's only native path needs a user step at launch or in the session.
2. **Narrowed:** Claude Code's "before first Stop" cell is closed in the interactive TUI by a `SessionStart` asyncRewake
   arm. That arm is currently deferred in the plan (Q2/KTD11 and the deferred list), because of #89960 and because it
   changes hash-pinned plugin files. Re-opening it is a plan decision for the Executor or operator, made through a
   `chore(release)` PR.
3. **Still open (untested here):** GNOME Terminal, Terminal.app, Windows Terminal and conhost for Gemini CLI and
   Antigravity CLI, and the editor-terminal path (C2) that U41 relies on.

The operator's options, as the plan sets them out: accept a UX change for these cells (for Antigravity, for example,
users start `agy --remote-control`), or do not claim wake parity for Gemini CLI and Antigravity CLI in terminals
without remote control.

## Consequences for dependent units

- **U14 (#1135), terminal wake:**
  - use the `emptyPrompt` regexes above together with the `cursor_x` input-column check;
  - accept U+00A0 after Claude's `❯`;
  - pause about 0.5 s between `send-keys -l` and `Enter`, because Codex, Gemini and Muse need it;
  - read only the cursor line, never the whole screen;
  - optionally require dim SGR for Claude and Codex placeholders through `capture-pane -e`.
- **U27 (#1141) Gemini, U29 (#1151) Antigravity, U31 Qwen, U33 Muse, and the OpenCode and Copilot adapters:** take
  `emptyPrompt` from the table. Qwen Code still needs a capture, through U30, U31 or a rerun of U38.
- **U41 (#1152), editor-terminal wake:** C2 is UNTESTED, so U41's path is unproven. It must not start on this evidence.
- **U28 (#1115), Antigravity contract:** item 4 should check whether the Remote Control daemon or the local language
  server (CSRF token source, `SendUserCascadeMessage`) can start a turn in an already-running TUI without a launch
  flag.
- **U12 (#1131, closed) and the Claude ladder:** C6 is evidence for adding the `SessionStart` asyncRewake arm, gated
  to the interactive TUI. It changes hash-pinned plugin files, so it needs a plan decision and a `chore(release)` PR.
- **U36 (#1158), live matrix:** HB1 cells as above. The tmux rows should include the Enter-delay case.
- **U37 (#1159):** this spike created no `experiments/terminal-hosts/`, so there is nothing to delete.

## Operator actions to finish this spike

1. **C2:** install VS Code and Cursor on a machine with a GUI session, then run the throwaway extension test as the
   ticket specifies: unfocused, then focused while typing in an editor.
2. **C3:** on Windows, test Windows Terminal and conhost with Gemini CLI, Copilot CLI and Claude Code.
3. **C4b and C4c:** on Linux, install GNOME Terminal; on macOS, use Terminal.app. Look for documented IPC that writes
   to a pane's input.
4. **C1 for Qwen Code:** install Qwen Code and capture its empty and draft lines with the same `capture-pane` method.
   `verify.py` takes a capture directory as its argument.
