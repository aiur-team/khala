# Delivery: quiet wakes, single delivery, digest, Markdown (2026-10-22)

Stream A of the Khala fan-out. Sources: `khala-findings.md` (F-B, F-D; Aiur #2, #7, #13) and `cursor-wake-research.md`.

## 1. Cursor stop nudge (F-B). Shipped in #1295
Cursor submits `followup_message` as a user turn, so it now carries only `Khala: channel messages are waiting. Call khala_read.` The cursor still advances at the nudge, so each batch produces one nudge. The agent reads the content with `khala_read`.

## 2. Quiet Sync wakes (Aiur #2)
- One predicate, `wakesAgent(entry, mode, you)` in `events/receive.ts`. A message wakes when the mode isn't Sync, when the sender is not an agent (`human` or `unknown`), or when the body names the agent's current display name (the existing `mentions` rule, moved from `watch.ts`).
- Every wake path uses it:
  - Stop re-open in `deliver-core` (only `stop` events are quiet; prompt and tool rules are unchanged);
  - the Claude `asyncRewake` watcher (`hooks/claude-wake.ts`);
  - the shared wake ladder (Codex, OpenCode, Qwen and the rest);
  - the `khala watch` monitor line.
- Quiet messages stay unread and arrive with the next prompt's hook context, or together with the next batch that wakes.
- Decision: `unknown` senders count as people. Missing a person costs more than one extra wake.
- Limit: harnesses whose prompt hook cannot inject context (Cursor, Gemini, Copilot, Antigravity) deliver quiet Sync messages only when they share a batch with a waking one, or through `khala_read`.

## 3. Exactly-once Stop delivery (F-D)
- Root cause: Khala ran the hook once and advanced the cursor once. Claude Code (2.1.304, seen in the session transcript) then rendered the `decision: block` reason twice: once as a "Stop hook feedback" user message and once as a "Stop hook blocking error" system note.
- Fix: Claude's Stop frame now goes in `hookSpecificOutput.additionalContext` (the `claudeCodec`).
- A live check on 2.1.307 showed it arrives once, as a system reminder, and the turn continues. Versions 2.1.302 through 2.1.307 all include the Stop schema.
- Codex keeps `decision: block`, since its Stop schema is not verified.

## 4. Digest after absence (Aiur #13)
This already holds. `selectFrames` puts each channel's backlog into one frame per hook, capped at 50 entries or 64 KiB. The goldens `deliver-*-51.json` and the test "batches fifty messages and leaves the rest unread" cover it. Per-message blocks came from a wake firing per message. Quiet wakes reduce that. No change.

## 5. Markdown intact (Aiur #7)
This already holds. `renderLine` keeps every newline and indents continuation lines by two spaces, so that a body cannot forge a frame line. Lists, nesting and code fences survive. A regression test was added. The flattening seen was Claude Code's one-line preview of a blocking Stop reason, and item 3 removes that path.
