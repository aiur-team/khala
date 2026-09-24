# Evidence sanitization and cleanup

Retained evidence is allowlisted: host, exact executable paths and hashes,
OpenCode/plugin versions, provider/model identifier, fixed synthetic nonces,
batch/message IDs, event types, timestamps, HTTP status codes, and a hash of the
disposable session ID.

The following are excluded: provider credentials, server passwords, raw local
authentication files, unhashed session IDs, unrelated configuration, private
transcripts, and arbitrary tool output. Peer bodies in fixtures are synthetic
and intentionally retained.

Runtime state, event logs, and the generated server password were created under
the workspace-private scratch directory with mode `0600`. At cleanup, all TUI
and server listeners on the proof ports were stopped. The temporary password,
HTTP response bodies, raw state, and unsanitized event log are not committed and
are removed after the retained evidence is checked. Hard abort was never used.
