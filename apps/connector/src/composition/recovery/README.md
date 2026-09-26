# Connector recovery composition (KHA-136)

`registerRecovery` replaces KHA-133's unavailable placeholder. Given a `lifecycle` dependency
(`storageRecoveryDeps({ storage, dispatcher, bindingId })` over the opened ledger), its `start`
inspects the reopened or restored ledger with `recoverConnectorStorage` and reconciles it:

- A release with any dispatch evidence and no terminal receipt stays **held** with an unknown
  outcome. The lifecycle only asks `Dispatcher.reconcile` for external evidence, which never
  requeues it. Only the owner's `Dispatcher.abandon` ends an unknown outcome. A restored snapshot
  never makes such a release eligible again.
- Dispatch is **blocked** when the ledger fails its integrity or payload check, when this binding or
  its device is revoked (revocation is permanent in the ledger), or when the ledger already holds a
  newer generation of this binding. Quarantine is enforced per stream by storage and is reported only.
- The capability is `ready` only when dispatch is allowed, so a runtime that lists `recovery` in
  `requiredCapabilities` never dispatches from a blocked or uninspected ledger.

`cleanup()` runs one `sweepRetention` call through the optional `sweep` dependency, and only after
reconciliation. It also runs while dispatch is blocked, so a revoked binding's local copies can
still be cleaned up. A failed sweep is reported as `failed`; revoked authority stays enforced and
the sweep resumes from its cursor on the next call. Cleanup is local only (P13): it does not recall
released model context, another participant's copy or remote ciphertext.

`observe()` gives the owner release IDs and counts only, never content. `stop` discards any
reconciliation still in flight and closes only this lifecycle, never the shared ledger or dispatcher.

## Not wired here

- No production connector entry point calls `createConnectorRuntime` yet, so nothing supplies the
  `lifecycle` dependency outside tests.
- No retention policy is approved (G-RETENTION selects no horizon), so `sweep` has no production
  binding. `sweepRetention` refuses without a policy.
- Messaging-device removal and session rotation (`ProtocolRevocationPort`) have no Matrix adapter.
