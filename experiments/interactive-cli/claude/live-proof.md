# Claude Code 2.1.282 interactive proof log

Host timestamps are UTC unless an offset is shown. These are sanitized excerpts from real interactive TTY sessions; `events.jsonl` beside each run is the raw hook/server timing log. Message bodies appear here only as synthetic markers. Private Claude configuration and transcripts are excluded.

## Steer — `PostToolUse`

- Session: `0595a54a-1686-49c7-b3d7-299a7ec179d0`
- Tool output: `2026-09-24T15:14:18.025920467-07:00`, then `2026-09-24T15:14:38.028612180-07:00`
- Message `STEER-PROOF-165` was staged during the 20-second sleep with batch `batch-steer-165`.
- `PostToolUse` began at `22:14:38.059Z`; its atomic claim completed at `22:14:38.061Z`, about 32 ms after the tool's second timestamp.
- The interactive session rendered `[khala:batch-steer-165] STEER-PROOF-165` before its first `Stop` at `22:14:39.053Z`.
- No interrupt or abort signal was sent. The tool completed normally.

## Sync — `Stop`

- Session: `65ddfc20-7a0d-4397-b7d9-377c4bddd879`
- Tool output: `2026-09-24T15:15:34.687402977-07:00`, then `2026-09-24T15:15:54.690358212-07:00`
- Message `SYNC-PROOF-165` was staged during the sleep with batch `batch-sync-165`.
- `PostToolUse` ran at `22:15:54.722Z` and did not claim the sync batch.
- Claude reported `TOOL-DONE-165`, then `Stop` began at `22:15:55.538Z` and claimed the batch at `22:15:55.540Z`.
- The decision-block reason delivered `[khala:batch-sync-165] SYNC-PROOF-165`; Claude continued once. The next `Stop` had `stop_hook_active=true` at `22:15:56.329Z`, preventing a loop.

## Idle wake primitive — `UserPromptSubmit` + `asyncRewake`

- Session: `50d9052e-45c5-4e24-a908-4d919cde4934`
- Claude said `IDLE-READY-165` and stopped at `22:16:43.872Z`.
- Without another user prompt, `REWAKE-PROOF-165` was staged about 17 seconds later.
- The original live spike claimed it at `22:17:00.846Z`, returned the synthetic marker through the exit-2 wake, and caused Claude to emit a synthetic `UserPromptSubmit` at `22:17:00.884Z` in the same session with a new prompt ID. The review-hardened committed probe now uses a fixed content-free wake marker and claims the batch as structured `additionalContext` on that second hook invocation; its regression test pins the two-step shape.
- This proves a bounded idle-wake primitive. It is not the product's `async` mode, which must remain agent-initiated.

## Async — explicit pull

- Interactive Claude session: `69c1cbf1-555b-4cba-a27d-38733fe03de0`; proof binding key: `pull-session-165`.
- `ASYNC-PROOF-165` was staged before the prompt with batch `batch-pull-165`. Arrival caused no hook, prompt, or model activity.
- The user asked Claude to decide whether to check the channel. Claude chose to invoke `read-pending.mjs` as one Bash tool call.
- The explicit pull was recorded at `22:19:04.246Z`; the same interactive session reported `[khala:batch-pull-165] ASYNC-PROOF-165`.

## Experimental native channel

- Interactive session: `6d57a3a2-ffd1-492a-a32c-7ddd5cdcfc48`.
- Launch required the hidden `--dangerously-load-development-channels server:khala-proof` flag and an explicit full-screen local-development confirmation.
- The MCP server declared `experimental["claude/channel"]` and sent `notifications/claude/channel` over stdio. Its localhost HTTP ingress put message bytes in the POST body, not process argv.
- Idle: server listening `22:20:39.456Z`; notification `CHANNEL-IDLE-PROOF-165` sent `22:20:46.211Z`; the idle Claude session woke and reported it.
- Busy: Bash ran from `15:21:25` to `15:21:45 -07:00`; notification `CHANNEL-BUSY-PROOF-165` was sent at `22:21:29.847Z` during the sleep. The UI displayed the channel event while the tool was busy, and Claude consumed it after the tool completed, reporting both `TOOL-DONE-CHANNEL-165` and the channel marker. The tool was not aborted.
- The CLI warning says approved channels should use `--channels`; official documentation says the development flag bypasses only the allowlist and does not bypass the `channelsEnabled` organization policy.

## Restart/deduplication safety

The proof helpers simulate the shared E09 batch-token contract: delivery moves a batch to `delivered`, and the next trusted Khala call moves it to acknowledged state. After acknowledging `batch-steer-165`, staging the same token failed with `batch already acknowledged`. The committed Node test repeats that assertion and proves a pull cannot consume another session's batch.

This is transport/release evidence, not a claim that Claude provides a durable model-consumption receipt. Production acknowledgement remains Khala-owned.
