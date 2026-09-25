# `@khala/messaging/recovery`

This module implements the messaging `RecoveryPort` under product decision P14: Khala offers no
old-history recovery and holds no escrow. Losing every enrolled device makes prior encrypted history
unrecoverable. OAuth login restores account access only; it does not restore message keys.

`capabilities()` therefore exposes no recovery mode. A signed-in matching owner receives
`unsupported_substrate`: this is a P14 policy refusal, not a pending setup step. Signed-out is a
distinct state and returns `signed_out`; identity failures and signed-in sessions for the wrong
owner both return `device_not_ready`. A contracts follow-up should add a dedicated
`policy_disallowed` reason, because contract changes are outside this ticket. `begin()` always
rejects `unsupported_mode` without invoking `ProvideRecoverySecret`, and `inspect()` returns
`not_found` because the service never creates a recovery operation or journal.

Fresh-device enrolment and channel re-admission live in their owning modules. They must not backfill old
history. Each existing timeline `missing_key` entry is a per-event row representing ciphertext that
a replacement device cannot decrypt; it is not recovered history. This module has no SDK backup,
secret, storage, release, dispatch, binding or membership dependency, so it cannot become an escrow
or replay path.
