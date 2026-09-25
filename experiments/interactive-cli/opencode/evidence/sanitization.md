# Evidence sanitization and cleanup

Retained evidence is allowlisted:

- **Environment:** host placeholder, exact executable paths and hashes,
  OpenCode and plugin versions, and the provider and model identifier.
- **Launch:** the launch commands, TUI PIDs, launch IDs, and the disposable
  session ID. Decision 33 requires the session ID on every event, so it is kept
  unhashed.
- **Content:** the fixed synthetic nonces and prompts, batch and message IDs,
  event types, and timestamps.
- **Transcript:** the stored text and tool parts of the synthetic proof
  session.

The following are excluded:

- provider credentials and raw local authentication files;
- the server password (the 2026-09-24 auth check only);
- unrelated configuration and private transcripts;
- `/home/<user>` prefixes, which are replaced with `~` or `<repo>`.

Peer bodies in fixtures are synthetic and intentionally retained.

Runtime state and the raw event log were written to a workspace-private scratch
directory, mode `0700`, with files at mode `0600`. The committed
`mode-events.jsonl` drops streaming message-part and catalog events and the
`monotonicNs` field. Nothing else is rewritten. The TUI ran with no TCP listener
and was stopped at the end. Hard abort was never used.
