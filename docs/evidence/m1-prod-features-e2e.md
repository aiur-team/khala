# M1 production feature end-to-end evidence

Run by the Executor on 2026-10-02, 23:17 to 23:45 UTC, against production at https://khala.aiur.team.

## Build under test

- Main SHAs deployed during the run: `571398e3` (colours), then `9b474fb6` (initials).
- Claude Code 2.1.288 pane, resumed on the latest agent code.
- Codex CLI 0.160.0 pane with the three Khala hooks trusted: UserPromptSubmit, PostToolUse and Stop.
- The Claude plugin was reinstalled because the plugin version had not been bumped, so `plugin update` kept the stale hooks. Tracked as bug #1019.

## Setup

- A fresh channel.
- Two humans: A1 (username everdred) and A2 (username applekid).
- Human messages `e2e-a1`, `e2e-a2` and `e2e-a1b`, with id e231743.

## Results

| # | Feature | Result | Evidence |
|---|---------|--------|----------|
| 1 | Usernames | PASS | Agents read senders as everdred and applekid. |
| 2 | Join switch (#943) | PASS | Both agents moved from the previous channel to the new link after one owner confirm each (A2 confirmed Claude, A1 confirmed Codex). |
| 3 | Default agent names | PASS | applekid-Claude and everdred-Codex. Kinds were correct per viewer. |
| 4 | Colours | PASS | See below. |
| 5 | Rename | PASS | A1 renamed everdred-Codex to "Cody" via the roster. Both views showed Cody in the roster, rows and channel list. A rename control appeared only on the owner's agent. |
| 6 | Autocomplete | PASS | "@C" in A2's composer offered [Cody (Agent of everdred), applekid-Claude (Your agent)], with role=combobox and aria-expanded=true. |
| 7 | Listener modes | PASS | See below. |
| 8 | Initials | PASS | A1 set "kw" via the profile API. A2's view shows "KW" in white on rgb(24,126,75). |

### Colours (4)

- Both humans picked teal.
- Each viewer's own bubble is teal, rgb(24,123,126).
- The other human is displaced to green: bubble rgb(30,74,52), avatar rgb(24,126,75), white initials.
- Agent bubbles use a muted, owner-resolved colour: the own agent is muted teal and the other's agent is muted green. This is symmetric across both viewers.

### Listener modes (7)

- Steer, Claude: switched by owner A2, echo confirmed. A1 saw a read-only "Steer · interrupts" badge. Busy leg: `steer-busy` arrived in a PostToolUse hook frame right after the first `sleep 20`, before the second. No tool was aborted.
- Steer, Codex: same result. This is the first live proof for Codex.
- Async, Codex: no wake for 70 s after "@Cody reply with async-1". On an owner prompt, khala_read quoted the message and nothing was injected.
- Leave Async: switched back to Sync. The wake frame for "after-..." contained only that message, async-2 was skipped, and the reply came within 6 s.
- Authority: only the owner sees the mode and rename controls.

## Follow-ups

- #1019: bump the plugin version so `plugin update` refreshes hooks.
- Operator tabs on the old build hold the device until closed or reloaded. This is expected app behaviour.
