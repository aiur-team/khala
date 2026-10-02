# M1 local four-party acceptance (KM-151)

Run 2026-10-02, 08:28–09:07 UTC, by the Khala Claude Executor driving both humans through the
`tests/acceptance/humans.mjs` WebDriver BiDi driver (runbook `tests/acceptance/m1-local.md`).

**Result: PASS.** AE1–AE4 and AE6 pass; AE5 not needed. Three non-blocking findings follow; none
affects the product's happy path.

## Candidate and versions

| Item | Value |
|---|---|
| `ACC_SHA` | `2db1eb371b9c8082c6d33d3db441206ca4c19934` (origin/main at 3a) |
| Node | v24.18.0 |
| Synapse | 1.161.0 (local stack, wiped and restarted before 3d) |
| matrix-js-sdk | 42.4.0 |
| Claude Code | 2.1.287 (pane model reported: Claude Haiku 4.5) |
| Codex CLI | 0.160.0 (pane model: GPT-6-Luna low) |
| Firefox | 152.0.6 (A1 on BiDi :9222, A2 on BiDi :9223) |
| Origin | `https://127.0.0.1:8443` (loopback; Dex users `alice` = A1, `bob` = A2) |

Ownership: A1 (Alice) owns Codex; A2 (Bob) owns Claude.

## Results

| Check | Result | Evidence |
|---|---|---|
| AE1 join + history | PASS | Both agents joined after one owner confirmation each; both `khala_status` = connected; both `khala_read` returned `m1-hello-082958`, `m2-082958`, `m3-082958`, which were sent before either agent joined (MSC4268 history bundle). |
| AE2 Codex idle wake | PASS | Bob 09:01:59 "Codex: reply with ack-codex-082958" → Codex row observed by 09:02:12 (≤ 13 s; driver poll granularity 5 s). Codex reports the turn was started by a Khala frame. |
| Claude idle wake | PASS | Alice 09:02:17 → Claude `ack-claude-082958` observed 09:02:23 (≤ 6 s). Started by a Khala frame. |
| AE3 Claude busy | PASS | Bob 09:02:28 asked for `sleep 20`; Alice sent `busy-check-082958` at 09:02:36 while the tool ran. Claude reports the sleep completed and was not aborted, and the busy-check text first appeared after `sleep 20` returned, in the Stop-hook block "Khala: new channel messages" carrying `<khala-channel-messages … count="1">`. `busy-done-082958` observed 09:02:56. |
| Agent ↔ agent | PASS | Alice 09:03:12 → Claude asked "Codex: what is the current time in UTC?" → Codex answered "09:03:26 UTC". No follow-on loop in the next 60 s. |
| AE4 no self-wake | PASS | Codex reports no turn started from its own messages. Its `inbox.jsonl` holds 3 `@agent-` rows, all Claude's (`@agent-5563…`), none with Codex's own id (`@agent-7709…`). |
| AE5 fallback | n/a | No wake leg failed. |
| AE6 reload + attribution | PASS | Both `transcript --reload` outputs hold all 13 messages from 3d–3f. Every agent row has its label, kind and owner tag, correct from each viewer's side (below). |

## Reload transcripts (AE6)

A1 (Alice):

```json
[
  {
    "sender": "You",
    "kind": "You",
    "text": "m1-hello-082958"
  },
  {
    "sender": "Bob",
    "kind": "Human",
    "text": "m2-082958"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "m3-082958"
  },
  {
    "sender": "Bob",
    "kind": "Human",
    "text": "Codex: reply with ack-codex-082958"
  },
  {
    "sender": "Codex",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "ack-codex-082958"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Claude: reply with ack-claude-082958"
  },
  {
    "sender": "Claude",
    "kind": "Another person's agent",
    "owner": "Bob’s machine",
    "text": "ack-claude-082958"
  },
  {
    "sender": "Bob",
    "kind": "Human",
    "text": "Claude: run sleep 20 in Bash now, then reply with busy-done-082958"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "busy-check-082958"
  },
  {
    "sender": "Claude",
    "kind": "Another person's agent",
    "owner": "Bob’s machine",
    "text": "busy-done-082958"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Claude, ask Codex one question in this channel; Codex, answer it."
  },
  {
    "sender": "Claude",
    "kind": "Another person's agent",
    "owner": "Bob’s machine",
    "text": "Codex: what is the current time in UTC?"
  },
  {
    "sender": "Codex",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "09:03:26 UTC"
  }
]
```

A2 (Bob):

```json
[
  {
    "sender": "Alice",
    "kind": "Human",
    "text": "m1-hello-082958"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "m2-082958"
  },
  {
    "sender": "Alice",
    "kind": "Human",
    "text": "m3-082958"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Codex: reply with ack-codex-082958"
  },
  {
    "sender": "Codex",
    "kind": "Another person's agent",
    "owner": "Alice’s machine",
    "text": "ack-codex-082958"
  },
  {
    "sender": "Alice",
    "kind": "Human",
    "text": "Claude: reply with ack-claude-082958"
  },
  {
    "sender": "Claude",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "ack-claude-082958"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Claude: run sleep 20 in Bash now, then reply with busy-done-082958"
  },
  {
    "sender": "Alice",
    "kind": "Human",
    "text": "busy-check-082958"
  },
  {
    "sender": "Claude",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "busy-done-082958"
  },
  {
    "sender": "Alice",
    "kind": "Human",
    "text": "Claude, ask Codex one question in this channel; Codex, answer it."
  },
  {
    "sender": "Claude",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "Codex: what is the current time in UTC?"
  },
  {
    "sender": "Codex",
    "kind": "Another person's agent",
    "owner": "Alice’s machine",
    "text": "09:03:26 UTC"
  }
]
```

## Install steps actually needed (3b)

1. Uninstalled the pre-reset global `@aiur/khala`.
2. `~/.local/bin/khala` wrapper → `node <wt>/packages/agent/bin/khala.mjs`, with `NODE_EXTRA_CA_CERTS`
   set to the local stack's certificate (a running pane cannot change its own environment).
3. Claude: disabled the old `khala@khala` and `khala-proof` plugins; added marketplace
   `<wt>/packages/agent/claude-plugin` as `khala-m1`; installed `khala@khala-m1` at user scope.
4. Codex: commented out the old `[mcp_servers.khala]` table; appended the table from
   `packages/agent/codex/config.toml.example` with explicit `HOME` and `XDG_STATE_HOME`; removed four
   old hook handlers from `~/.codex/hooks.json` so only the two `khala hook deliver --harness codex`
   entries remain.
5. Restarted both panes on their same sessions (`claude --resume <id>`, `codex resume <id>`). Codex
   showed "Hooks need review" for the 2 new hooks; the Executor chose **Trust all and continue**.
6. Both panes then listed exactly `khala_event`, `khala_join`, `khala_read`, `khala_send`,
   `khala_status` from the new server.

The Claude pane did not exit on a typed `/exit` (it was treated as input), so the Executor sent
SIGTERM to the pane's `claude` process and typed the resume command. Killing the old Codex process left
its terminal in kitty-keyboard/synchronized-output mode, so the pane was replaced by a new terminal
running `codex resume` on the same thread.

## I8 pane typing (all were the I8a re-arm prompt unless noted)

| UTC | Pane | Why |
|---|---|---|
| ~08:27 | both | 3b: ask for the post-resume tool list (custom prompt) |
| 08:29:45 | both | 3c brief not picked up by the file monitors |
| 08:31:37 | Claude | 3e join post missed by its monitor |
| 08:51:06 | both | 3e status/read post missed |
| 08:53:50 | both | 3f pre-instruction, before any leg |
| 09:05:21 | both | report request, after the last leg |
| ~09:05:40 | Claude | AE3 clarification question |

No typing and no file writes happened between 08:55 and 09:04 (the legs). The panes' `tail -n 0 -F`
monitors missed most Executor posts; every leg was woken by Khala itself.

## Findings (non-blocking)

- **F1. A2 confirm page did not show its done state.** `confirm --as a2` for Claude ended with
  `confirm_timeout`, yet Synapse logged the invite and the agent's join at 08:32:04, and Claude
  reported `connected` with full history. The `/agent/confirm` tab rendered the app shell (conversation
  list) instead of the `AgentConfirm` "Claude joined …" card. A1's confirm for Codex passed. Follow-up ticket.
- **F2. The driver does not hand the device back after a failed confirm.** After F1, A2's run tab stayed
  paused ("Khala is active in another tab"), so the first AE2 `say` failed with `channel_not_ready`
  and no message was sent. Recovered with `cleanup --as a2`. Follow-up ticket.
- **F3. `wait-for` matches the prompt row.** When the human's prompt contains the expected token,
  `wait-for` returns the human's own row. The legs used a transcript poll filtered by `sender` instead.
  Follow-up ticket.
- **Note.** Codex wakes for every channel message, including those addressed to Claude, and decides
  not to reply. This is expected M1 behaviour (no addressing filter).
