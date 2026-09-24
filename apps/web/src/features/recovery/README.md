# Recovery UI composition handoff

`RecoveryPanel` and `createRecoveryController` are the production display and
lifecycle boundary for recovery, revocation, and channel closure. KHA-136 should
adapt real SDK operations to `RecoveryPorts`; it must not replace the panel's
state semantics.

P14 permits no recovery mode. Messaging reports `unsupported_substrate`, and
the panel renders “Recovery is not available” without a configure action,
recovery-key input, or automatic prompt. No `unavailableReason` is interpreted
as a request to set recovery up.

The `RecoveryUiPort` contract retains the canonical local-only recovery callback
for future separately approved composition, but the current panel never invokes
it. Effectful revocation and closure calls allocate and store a scoped operation
reference first and use that same operation ID for inspection after an unknown
outcome. The resume store contains only operation kind/ID and owner, device, and
channel scope. A real adapter must independently revalidate authority, device
generation, channel identity (`roomId`), and expected channel revision (`roomRevision`).

Closure semantics are fixed: stop future messages, remove the channel from the
owner's view, and request cleanup on the owner's devices. Already-delivered
participant or model copies cannot be recalled. Service retention is separate;
this UI promises neither a deletion window nor global erasure.

`browser-harness/` is synthetic-only. It has no network, storage, crypto,
authorization, or real recovery capability. Its browser spec proves the
production panel/controller's P14 refusal, operation identity, announcements,
keyboard flow, closure consequences, and narrow reflow; it is not evidence that
a real SDK operation or cleanup completed.
