# M1 production four-party acceptance (KM-152)

Run 2026-10-02, 15:31–15:45 UTC, on `https://khala.aiur.team` (main `079805f6`, deploy `6abfcc70…`).
The Executor drove two humans through `tests/acceptance/humans.mjs` (A1 on Firefox BiDi 9222, A2 on 9223).
It coordinated the operator's Claude Code and Codex panes through `AGENT-MESSAGES.md`. The reset is
described in [m1-prod-reset](../operations/m1-prod-reset.md).

**Result: PASS.** AE1–AE4 and AE6 pass in production. AE5 was not needed.

## Versions

Node 24.18.0 (driver and local build); matrix-js-sdk 42.4.0; Claude Code 2.1.287 (pane model Claude Haiku 4.5);
Codex CLI 0.160.0; Firefox 152.0.6; Synapse on Railway (`matrix.khala.aiur.team`).

## First devices (I6)

- The namespace rotated at ~15:00 UTC. Both Firefoxes then ran `reset-site` for `https://khala.aiur.team`.
- A2's first sign-in was `signin` at 15:25:55 UTC.
- A1's driver sign-in looped on `login_replayed`, so the operator completed A1's Google sign-in by hand in the same
  9222 Firefox at ~15:29 UTC (A1's human sign-in step was operator-driven). The run tab then needed that
  operator tab closed, since only one tab per owner holds the device.
- No other browser signed in between the rotation and these sign-ins.

## Results

| Check | Result | Evidence |
|---|---|---|
| AE1 join + history | PASS | A2 confirmed Claude and A1 confirmed Codex (`… joined M1 acceptance 2026-10-02.`). Both `khala_status` = connected. Both `khala_read` returned `m1-hello-p153631`, `m2-p153631` and `m3-p153631`, which were sent before either agent joined. |
| AE2 Codex idle | PASS | Sent 15:41:07, Codex row observed 15:41:12 (≤ 5 s). Started by a Khala frame. |
| Claude idle | PASS | Sent 15:41:12, Claude row observed 15:41:17 (≤ 5 s). Started by a Khala frame. |
| AE3 Claude busy | PASS | `sleep 20` requested 15:41:17; `busy-check` sent 15:41:26 during the sleep. Claude reports the sleep was not aborted and the busy-check text first appeared in hook context after the sleep returned. `busy-done` observed 15:41:43. |
| Agent ↔ agent | PASS | Claude asked "Codex: what is 2 plus 2?"; Codex answered "4". |
| AE4 no self-wake | PASS | Codex's inbox holds only Claude's agent rows (`@agent-2bada8d…`), never its own. Codex reports no turn started from its own messages. |
| AE5 fallback | n/a | No wake leg failed. |
| AE6 reload + attribution | PASS | Both `transcript --reload` outputs hold all 13 messages. Every agent row has its label, kind and owner tag, correct from each side. |

Wake-leg driver log:

```
AE2 send 15:41:07
{"sender":"Codex","kind":"Your agent","owner":"Your machine","text":"ack-codex-p153631"}
AE2 got 15:41:12
Claude-idle send 15:41:12
{"sender":"Claude","kind":"Your agent","owner":"Your machine","text":"ack-claude-p153631"}
Claude-idle got 15:41:17
AE3 send 15:41:17
AE3 busy-check 15:41:26
{"sender":"Claude","kind":"Your agent","owner":"Your machine","text":"busy-done-p153631"}
AE3 got 15:41:43
A2A send 15:41:53
{"sender":"You","kind":"You","text":"Claude, ask Codex one question in this channel; Codex, answer it."}
{"sender":"Claude","kind":"Another person's agent","owner":"Its’s machine","text":"Codex: what is 2 plus 2?"}
{"sender":"Codex","kind":"Your agent","owner":"Your machine","text":"4"}
A2A checked 15:42:56
```

## Reload transcripts (AE6)

A1:

```json
[
  {
    "sender": "You",
    "kind": "You",
    "text": "m1-hello-p153631"
  },
  {
    "sender": "Its #Fybo",
    "kind": "Human",
    "text": "m2-p153631"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "m3-p153631"
  },
  {
    "sender": "Its #Fybo",
    "kind": "Human",
    "text": "Codex: reply with ack-codex-p153631"
  },
  {
    "sender": "Codex",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "ack-codex-p153631"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Claude: reply with ack-claude-p153631"
  },
  {
    "sender": "Claude",
    "kind": "Another person's agent",
    "owner": "Its’s machine",
    "text": "ack-claude-p153631"
  },
  {
    "sender": "Its #Fybo",
    "kind": "Human",
    "text": "Claude: run sleep 20 in Bash now, then reply with busy-done-p153631"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "busy-check-p153631"
  },
  {
    "sender": "Claude",
    "kind": "Another person's agent",
    "owner": "Its’s machine",
    "text": "busy-done-p153631"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Claude, ask Codex one question in this channel; Codex, answer it."
  },
  {
    "sender": "Claude",
    "kind": "Another person's agent",
    "owner": "Its’s machine",
    "text": "Codex: what is 2 plus 2?"
  },
  {
    "sender": "Codex",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "4"
  }
]
```

A2:

```json
[
  {
    "sender": "Its #3ky6",
    "kind": "Human",
    "text": "m1-hello-p153631"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "m2-p153631"
  },
  {
    "sender": "Its #3ky6",
    "kind": "Human",
    "text": "m3-p153631"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Codex: reply with ack-codex-p153631"
  },
  {
    "sender": "Codex",
    "kind": "Another person's agent",
    "owner": "Its’s machine",
    "text": "ack-codex-p153631"
  },
  {
    "sender": "Its #3ky6",
    "kind": "Human",
    "text": "Claude: reply with ack-claude-p153631"
  },
  {
    "sender": "Claude",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "ack-claude-p153631"
  },
  {
    "sender": "You",
    "kind": "You",
    "text": "Claude: run sleep 20 in Bash now, then reply with busy-done-p153631"
  },
  {
    "sender": "Its #3ky6",
    "kind": "Human",
    "text": "busy-check-p153631"
  },
  {
    "sender": "Claude",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "busy-done-p153631"
  },
  {
    "sender": "Its #3ky6",
    "kind": "Human",
    "text": "Claude, ask Codex one question in this channel; Codex, answer it."
  },
  {
    "sender": "Claude",
    "kind": "Your agent",
    "owner": "Your machine",
    "text": "Codex: what is 2 plus 2?"
  },
  {
    "sender": "Codex",
    "kind": "Another person's agent",
    "owner": "Its’s machine",
    "text": "4"
  }
]
```

## Pane typing (I8a re-arm prompts; none during the legs, 15:40:45–15:43:00)

15:31:44 both (production brief) · 15:36:48 both (join) · 15:38:19 both (status/read) · 15:39:05 both
(wake pre-instruction) · 15:43:40 both (report request) · 15:44:46 Claude (AE3 clarification). Before the run,
both panes' khala MCP servers were restarted (Codex `/quit` + `codex resume`, Claude SIGTERM + `claude --resume`),
because a running server answers `khala_join` with its existing channel.

## Observations

- Both Google accounts have the given name "Its". The app disambiguates the humans as `Its #Fybo` / `Its #3ky6`,
  and the other side sees agent owners as "Its’s machine". This is correct, but unfriendly for same-named people.
- A locally built deploy needs the production `PUBLIC_*` env (see the ops doc).
- When the operator signs in by hand in a second tab, the driver's run tab cannot get the device until that tab
  is closed ("Device handoff took too long").
