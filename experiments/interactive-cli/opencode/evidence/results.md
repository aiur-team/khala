# Interactive mode results

The terminal was a real OpenCode TUI started by the user. The retained session
reference is a SHA-256 digest of the local session ID; every mode event in
[`mode-events.jsonl`](mode-events.jsonl) maps to that same visible session. The
provider/model shown in the TUI was DeepSeek V4.1 Flash
(`deepseek/deepseek-flash`). For each nonce, the sanitized event subset also
retains the provider/model from the corresponding stored assistant message;
the raw session ID was matched to the retained SHA-256 digest before cleanup.

## `steer`

The channel batch was enqueued while `proof_gate` stage 1 was sleeping. At the
stage-1 `tool.execute.after` boundary, the plugin leased the batch and queued it
for `experimental.chat.messages.transform`. The transform applied 95 ms later.
DeepSeek called `khala_send(response=STEER-ACK-731)` 1.317 s after the transform;
stage 2 did not start until another 1.278 s after that send. The session reached
idle only after stage 2. No abort call occurred.

Result: **Proven**, using native plugin hooks (`tool.execute.after` plus the
next `experimental.chat.messages.transform`).

Negative control: `session.promptAsync` was accepted at an earlier stage-1
boundary, but stage 2 continued and the batch remained in flight without the
nonce acknowledgment. Therefore busy `promptAsync` is not the recommended
`steer` route for `1.17.10`.

## `sync`

The batch was enqueued during stage 1. Both stage 1 and stage 2 completed with
no channel action. The original turn reached `session.idle` at
`22:30:24.865Z`; the plugin leased the batch 10 ms later and the session-addressed
`promptAsync` call was accepted 9 ms after that. DeepSeek called
`khala_send(response=SYNC-ACK-482)` 2.012 s after idle.

Result: **Proven**, using a plugin-owned durable queue, the `session.idle` event,
and session-addressed `promptAsync` into the already-running TUI.

## `async`

After enqueue, a five-second snapshot still had no in-flight token. DeepSeek
then completed a separate `ASYNC-DEFERRED` turn without either channel tool;
the batch remained untouched. On a later turn, DeepSeek deliberately called
`khala_read`, received `batch-async-001`, and called
`khala_send(response=ASYNC-ACK-964)`.

Result: **Proven**, using the explicit `khala_read` tool. The product form may
be a plugin or MCP tool backed by the single shared Khala pull operation.

## Restart and acknowledgement

In a separate trial, `khala_read` leased `batch-async-001` and intentionally did
not send. The TUI process exited. After restarting the same user session, the
state still named that token as in flight and no automatic delivery occurred.
The next explicit `khala_read` acknowledged the retained token and returned no
messages (`NO-DUPLICATE`). There is no OpenCode-side cursor or dedupe database;
the stable Khala token and next Khala call define acknowledgement.

## Safety observations

- The proof launch bound only `127.0.0.1`; listener checks found no wildcard
  listener.
- Prompt and channel bytes were typed over the PTY or read from private state;
  they were not present in OpenCode argv.
- State and event files were mode `0600`.
- Peer text was wrapped as `peer-content-is-untrusted-data`; the user's own
  prompt authorized the nonce response. Existing tool permissions remained in
  force.
- Hard abort stayed off.
- Delivery was session-addressed except for the in-process transform of that
  session's current model input. No TUI append/submit endpoint touched a draft.
- The hardened fixture's deterministic two-session probe rejects a mismatched
  idle event, read, send, and acknowledgement without taking the batch. It also
  preserves mismatched user text byte-for-byte and retains a rejected sync
  lease as `uncertain` rather than acknowledging it. See
  [`session-safety.md`](session-safety.md).
