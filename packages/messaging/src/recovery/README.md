# `@khala/messaging/recovery`

This module implements the messaging `RecoveryPort` under product decision P14: Khala offers no
old-history recovery and holds no escrow. Losing every enrolled device makes prior encrypted history
unrecoverable. OAuth login restores account access only; it does not restore message keys.

`capabilities()` therefore exposes no recovery mode. A signed-in owner receives `not_configured`,
while signed-out and unavailable identity states stay distinct. `begin()` always rejects
`unsupported_mode` without invoking `ProvideRecoverySecret`, and `inspect()` returns `not_found`
because the service never creates a recovery operation or journal.

Fresh-device enrolment and room re-admission live in their owning modules. They must not backfill old
history. Existing timeline `missing_key` entries remain the explicit representation of ciphertext
that a replacement device cannot decrypt. This module has no SDK backup, secret, storage, release,
dispatch, binding or membership dependency, so it cannot become an escrow or replay path.
