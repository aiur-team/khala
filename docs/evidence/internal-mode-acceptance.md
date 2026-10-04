# Internal-mode live acceptance evidence (KI-161)

This records a live run of `tests/acceptance/internal-mode.md` on one machine. One owner (A1) used the operator's real Firefox over BiDi `:9222`. Two real agents took part: a Claude Code pane and a Codex pane. The panes were coordinated through `AGENT-MESSAGES.md`. No Khala server was involved and nobody signed in.

## Candidate and versions

| Item | Value |
|---|---|
| `ACC_SHA` | `a24790d142491e6f7363d02c716a655374c48d8b` (origin/main, worktree `.worktrees/internal-acceptance`) |
| Node (Khala processes) | v22.23.2 |
| Claude Code | 2.1.288. The pane model was Claude Haiku 4.5. |
| Codex | codex-cli 0.160.0 |
| Firefox | 152.0.6, default profile |
| Plugin | `khala@khala-m1` 0.2.1. Its content is byte-identical between d901cd3a and `ACC_SHA`, so no reinstall was needed. |
| Run window | 2026-10-04 16:01Z–17:45Z. Panes were restarted onto the guarded wrapper at 2026-10-03 19:30Z. |

KI-160 scripted acceptance at `ACC_SHA` (`pnpm --filter @khala/agent test:local-e2e`) passed all 12 AEs in 26.9 s. Durations in ms: AE1 816 · AE2 80 · AE3 19 · AE4 8438 · AE5 2014 · AE6 5403 · AE7 2817 · AE8 2048 · AE9 1564 · AE10 4 · AE11 1270 · AE12 1301.

## Results

| AE | Result | Evidence |
|---|---|---|
| AE1 Create | **PASS with finding** | Claude ran `khala local create refactor` and replied with a `…/join/FejN…` share link (16:07Z). The helper auto-started under the guard: a `serve` installed record, pid 3921602. **Finding:** Claude (Haiku 4.5) did not call `khala_join` with the `selfLink` as the skill instructs. It joined only after a prompt (16:32Z), so the members were `everdred, everdred-Claude`. |
| AE2 Join | **PASS on retry** | The first link expired (10 min) before the idle pane picked it up: `link_unavailable`, which is correct. On a fresh link, Codex `khala_join` returned "Connected to refactor." with no browser. Members became `everdred, everdred-Claude, everdred-Codex`, and the timeline showed the "everdred-Codex joined" pill (screenshot 1). |
| AE5 Human | **PASS** | The open link showed the channel with no sign-in: list, timeline pills, composer and chips (screenshot 1). Settings showed `Light mode` and `Profile @everdred`, with no Log out. Typing `@everdred-Co` opened the "Mention suggestions" listbox with `everdred-Codex`. Wake leg: `live-ae5` was sent at 16:40:03, and Claude replied `ack-ae5-1640` at 16:40:07, woken by asyncRewake. `resources --reload` showed `foreign: []`. Codex half: see AE5c below. |
| AE3 Chat | **PASS** | `live-ae3-ping-1640` (everdred-Claude) was followed by `live-ae3-pong-1640` (everdred-Codex), each exactly once. Inboxes for Claude and Codex both had n=40, duplicate eventIds 0, and own-sender entries 0. Codex was guarded and idle, so it was prompted to `khala_read` (I8 fallback, per runbook). |
| AE4a Codex → idle Claude | **PASS** | Claude was set to Async, then back to Sync. Codex sent `live-ae4a-wake-1640` at 16:42:33. Claude's turn started at 16:42:33 from the Stop-hook frame "Khala: new channel messages…", with no typed prompt. Claude treated the message as information because it did not come from the owner. |
| AE5c owner → idle Codex | **PASS** (unguarded window) | `live-ae5c2` was sent at 16:51:54.359Z. Codex's turn started at 16:51:54.459Z with the `codex queue` notice "Khala: channel messages are waiting. Continue.", followed by the hook frame. It replied `ack-ae5c2-1640` at 16:51:57.9Z. The replying member was `everdred-Codex-2`; see finding F2. |
| AE4b Claude → idle Codex | **PASS** (unguarded window) | Codex-2 was set to Async, then back to Sync. Claude sent `live-ae4b-wake-1640` at 17:03:25. Codex's turn started at 17:03:25.766 from the queue notice, followed by a frame containing the marker. |
| AE6 Listener modes | **PASS** | **Steer:** `steer-ae6` arrived after the first `sleep 20` and before the second, via PostToolUse:Bash, with no abort. **Sync:** `sync-ae6` arrived after the turn ended. **Async:** no Claude transcript entries for 70 s. On demand, `khala_read` quoted the message and `khala_send read-ok-1640` worked. **Leave Async:** the wake frame did not contain `live-ae6-backlog-1640` (count 0). Every roster mode change was confirmed within 0.5 s. |
| AE7 Profile | **PASS with finding** | Profile was set to `kev` / `KW` / Purple and saved. `owner.json` read `{"username":"kev","color":"purple","initials":"KW"}`, and agents were renamed `kev-Claude` and `kev-Codex(-2)`. `kev-Codex-2` was renamed to `reviewer` from the roster. After `khala local stop` and a fresh open link, username, colour, initials and `reviewer` all persisted (screenshot 3), and `resources` showed `foreign: []`. **Finding F3:** asked for names, Claude reported the stale `everdred-Codex-2` / `everdred-Claude`. It reported `reviewer` only after that agent spoke again (#1078). |
| AE9 Link hygiene | **PASS** | Replaying the consumed AE2 link gave `404 {"error":"link_unavailable"}`. Opening a share link in the browser did not consume it: its secrets entry had no `consumedAt`. Link in content: after 2 min the `other` channel still had only the owner, its link had no `consumedAt`, and both agents stayed on `refactor`. Expired link at T0+10m40s: `404 link_unavailable`. |
| AE8 Restart | **PASS** | The helper (pid 123417) was `kill -9`'d at 17:35:01 during Claude's sleep. An agent's next call restarted it as pid 253987. `live-ae8-a/-b-1640-r` each appear exactly once after reload. Inbox duplicates: 0 for both agents. Claude's cursor went from 64 to 66 (not reset). Claude ran the sleep as a background task, and the task's completion did not wake it, so `-b` was sent after an I8 prompt. That is Claude Code behaviour, not Khala. |
| AE11 Boundaries | **PASS** | Modes: 10 files `600` and 5 dirs `700`. `Host: evil.example` gave `421`. An owner cookie without `x-khala-local` gave `403`, and with an evil Origin also `403`. An agent token on `/api/local/channels` gave `403`. Owner `DELETE` of `reviewer` gave `204`, and the timeline showed "reviewer left". The removed token on `/rooms/…/members` gave `403 not_member`. Codex `khala_send` returned `{"error":"not_connected"}`, and `khala_status` returned `disconnected` / `removed`. |
| AE12 Persistence and delete | **PASS** | `lastSeq` was 77 before `khala local stop` and 77 after the restart. `khala local delete refactor` returned `{deleted}` and the channel dir is gone. Claude `khala_send` returned `{"error":"not_connected"}`, and `khala_status` returned `disconnected` / `channel_deleted`. The browser channel list no longer shows `refactor` (screenshot 4). |
| AE10 No egress | **PASS** | See Egress below. |

## Egress

- `egress.jsonl` summary: `{"processes":1641,"violations":[],"codexExceptions":2,"modules":0,"noModuleHooks":0,"serveProcesses":4,"seen":{"mcpClaude":true,"mcpCodex":true,"hookDeliver":true,"hookClaudeWake":true,"localCreate":true}}`. The two Codex exceptions are the expected denied `codex` waker launches while Codex was guarded (Executor ruling on #1014).
- The `ss` sampler took 75,527 socket samples from Khala processes. Every peer was `127.0.0.1`.
- Every `resources` call reported `{"origins":["http://127.0.0.1:47830"],"count":13,"foreign":[]}`.
- **Unguarded window:** the guarded wrapper was replaced from 16:42:52Z to 16:57:21Z. The Codex MCP server started in that window (pid 4107667) stayed unguarded for the rest of the run, because the runbook's second Codex restart was skipped: it would have created another duplicate member (F2). The helper that this MCP server restarted during AE8 (pid 253987, 17:35–17:39Z) was also unguarded. The `ss` sampler covered both, with loopback peers only. After `khala local stop` at AE12, a guarded helper took over (pid 266254).
- Under D3, Claude Code and Codex themselves talk to their model providers. They are not Khala processes and are outside the guard by design.

## Install steps actually needed

- The old E09 sources (`khala@khala`, `khala-proof@khala-proof`) were already disabled. The active plugin was `khala@khala-m1` 0.2.1, unchanged at `ACC_SHA`.
- `~/.local/bin/khala` was replaced by the guarded wrapper, and the unguarded wrapper was kept for the Section 4 window. The original was backed up to `~/khala-backups/panes-*/` and restored at teardown (byte-identical).
- Both panes were restarted onto the new MCP servers. Both reported exactly `khala_join, khala_status, khala_read, khala_send, khala_event`.

## Pane typing (I8)

All typed actions are logged with UTC times in the run's `pane-typing.log`. They fall into four groups:
- **Restarts:** Claude and Codex restarts (2026-10-03 19:30Z), the Codex restart for the unguarded window (16:43Z), and the Codex re-join after the restart (16:50Z).
- **Monitor re-arms:** the panes' `tail -F` monitors never woke an idle TUI, so instructions were followed by typed nudges.
- **Fallbacks while guarded:** Codex prompted for AE3, AE4a and AE11.
- **Claude prompts:** AE1 self-join, the AE6 Async on-demand read, AE8 `-b`, and the AE12 send. The first AE12 prompt was swallowed by the screensaver.

## Findings

| # | Finding | Owner |
|---|---|---|
| F1 | Claude (Haiku 4.5) skipped the skill's `khala_join selfLink` step after `khala local create`. It needed a prompt. | Skill wording or model behaviour; deferred. |
| F2 | A restarted agent that re-joins becomes a second member (`everdred-Codex-2`), leaving a ghost. The first fix attempt (#1079) was sent back for a session-takeover hole. | #1076 |
| F3 | Agents never learn about renames: there is no rename event in `khala_read` and no own `displayName` in `khala_status`. | #1078 |
| F4 | Executor error: the AE9 expiry `curl` ran at T0+9m and joined a stray `kev-Claude-2`. It was removed with an owner `DELETE`, and the check was redone with a fresh link at T0+10m40s. | Run procedure |
| F5 | Runbook: a restarted agent starts `disconnected` / `closed` and must re-join. §4 step 3 assumes it stays connected. | Runbook text |

## Screenshots

`internal-mode-acceptance/`, 645×603 each, all under 70 KB, with no tokens, cookies or open links:
1. `1-channel.png`: the channel after AE2, showing join pills and mention chips.
2. `2-roster-steer.png`: the timeline while Claude was in Steer. At this window width the roster is collapsed, so the Steer icon is not visible; the mode was confirmed through its accessible label.
3. `3-settings.png`: after the Profile save and restart, showing purple bubbles, `KW` badges and the `reviewer` chip. The Firefox "Unlock 1Password" tooltip belongs to the operator's extension.
4. `4-after-delete.png`: the channel list without `refactor`.
