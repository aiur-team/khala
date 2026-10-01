# Hosted manual MCP listening evidence

On 2026-10-01, separate production Codex and Claude native MCP model sessions
explicitly called `khala_read` after owner approval and reported released human
and peer messages. The private traces are under `/tmp/khala-prod-browser/`; this
file records only non-secret observations. The Codex completed MCP result
contained a released batch. Claude's subsequent model result reported the
message. These observations establish an explicit-pull route, not automatic
delivery at a native hook boundary.

Read-only inspection of the corresponding connector ledgers found one release
and **no** `agent_acknowledged` receipt for the Codex proof-key binding. Its
Async mode therefore remains unsupported. The Claude proof-key binding had two
releases and two `agent_acknowledged` receipts, both matching its current
binding and generation. Those older receipts do not record whether a hook or
an explicit MCP read delivered the batch. After each manual-route start, the
connector requires a new batch returned by an explicit call and its token
acknowledged in a later explicit call. It matches that route witness to the
durable agent-origin receipt before permitting Async, then projects the mode
to the dispatch ledger and reads it back before reporting it effective. A
restart, new generation, unavailable session inspection, or unreadable
receipt ledger closes this claim until new manual read/ACK evidence arrives.

Codex's hosted `codex-hook` fallback can select a binding and inspect its mode,
but this production observation did not test delivery from that hook. Claude's
installed hooks target its local session server, not the hosted manual inbox.
Neither route proves hosted Steer or Sync; both remain unsupported. An inbox
enqueue, queue exit, installed CLI version, or encrypted send alone promotes
no mode.

The production observations did not exercise owner browser mode changes. A
separate disposable HTTPS browser fixture must confirm owner set and
authoritative readback for each provider before the hosted product claim is
complete.
