# Claude Code 2.1.282 interactive proof log (normal trust)

All runs happened on 2026-09-25 (UTC). Each session was agent-launched with default settings:

```text
cd <proof-project> && env -i HOME=~ USER PATH TERM=xterm-256color LANG=en_US.UTF-8 SHELL=/bin/bash claude
```

There were no CLI flags. The plugin was installed once with `claude plugin marketplace add … --scope local` and `claude plugin install khala-proof@khala-proof --scope local`. The folder-trust dialog was accepted once on first launch. The user-default `auto` permission mode approved every Bash and `khala_*` call without prompting. Each run starts a fresh interactive session and fresh proof state.

| Run | Session | What it shows | Key timestamps |
|---|---|---|---|
| [`steer`](runs/steer/) | `567bbda0-5e29-412c-b61e-85d661475577` | `PostToolUse` delivery after a 20 s tool; the next Khala call acknowledges | tool start `00:34:42.979`, arrived `00:34:47.245`, tool end `00:35:04.229`, released `00:35:04.231`, acknowledged via `khala_send` `00:35:08.253` |
| [`sync`](runs/sync/) | `1cb99244-84c5-4e69-b331-fe1e4e728641` | `PostToolUse` skipped; `Stop` block; no loop | arrived `00:35:31.065`, tool end `00:35:47.829` (no release), released at `Stop` `00:35:49.202`, acknowledged `00:35:53.832`, `stop_hook_active=true` `00:35:56.748` |
| [`async`](runs/async/) | `bfed27a9-31aa-4313-baef-0e726d14273b` | No automatic activity; the agent chooses `khala_read`, bound to the MCP server's `CLAUDE_CODE_SESSION_ID` | arrived `00:36:09.690`, first activity is the human prompt `00:36:40.151`, released via `khala_read` `00:36:44.534`, acknowledged `00:36:47.899` |
| [`rewake-prompt40`](runs/rewake-prompt40/) | `1a1e7433-b9f2-4b7e-93b3-e8b86e737e7c` | The committed 40 s route: the wake works, but the backgrounded claim is lost and later acknowledged unseen; spurious wake while busy | armed `00:37:03.345`, arrived `00:37:20.107`, wake `00:37:20.190`, claimed by the async hook `00:37:20.231` (the model reports nothing received), acknowledged unseen `00:39:33.422`; busy wake `00:39:25.577` |
| [`rewake-prompt40-expiry`](runs/rewake-prompt40-expiry/) | `a36f2deb-655e-451d-890a-db077e0d54c4` | The 40 s bound: no wake after expiry | armed `00:49:21.378`, expired `00:50:01.477`, arrived `00:50:01.692`, no activity until the human prompt `00:51:02.153`, released at `Stop` `00:51:03.724` |
| [`rewake-stop-long`](runs/rewake-stop-long/) | `09c03b7e-04f8-4d1d-9e6a-696bcb9edd47` | Replacement: a `Stop`-armed watcher wakes after 150 s idle, a synchronous hook claims, the watcher re-arms, and it wakes again in `steer` mode | idle `00:40:38.597`; arrived `00:43:08.645`, wake `00:43:08.651`, released `00:43:08.705`, acknowledged `00:43:13.809`; re-armed `00:43:15.227`; arrived `00:44:34.735`, wake `00:44:34.893`, acknowledged `00:44:38.914`; no watcher process after `/exit` |
| [`restart`](runs/restart/) | `cf0e976e-46ee-4874-9d48-6b41adebf0db` → `f61a8ab1-3ab8-4979-ac89-fd507b23bcee` | SIGKILL after delivery; fencing; fresh-token redelivery; duplicate rejection | released `00:48:22.759` (token `f6567bf7110b`), SIGKILL `00:48:29.452`, generation 2 fenced/requeued `00:48:29.802`, old-token replay `stale_generation` `00:48:33.496`, redelivered with `ebfe00b497b5` `00:48:38.234`, acknowledged `00:48:42.893`, replay `duplicate` `00:48:46.827`, next turn empty |

A first `steer` attempt kept proof state inside the project directory. Claude 2.1.282's per-command "what this command changed" view then rendered an inbox file to the model, so that run was discarded and state moved beside the project. That attempt also acknowledged through a later hook pull, which led to the rule that only agent-initiated Khala calls acknowledge.

## Preview-gated channel (not in the matrix)

[`runs/channel-run`](runs/channel-run/events.jsonl) is from the earlier research pass. The custom `notifications/claude/channel` push woke an idle session and queued behind a busy tool, but it needed `--dangerously-load-development-channels server:khala-proof` and a full-screen confirmation. Decision 33 excludes that flag, so this is evidence about the preview's gates, not a proven route.
