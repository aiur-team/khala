# Connector controls composition (KHA-135)

`createPolicyControlHandler` serves the owner's trust, pause and status controls on the
protected human transport. `registerControls` replaces KHA-133's placeholder.

- **Serialization point.** A request becomes effective only when
  `ConnectorDispatchStorage.applyEffectivePolicy` commits it. Every dispatch claim after
  that commit sees the new version and pause flag. The returned `PolicyAck` is built from
  that commit, not from the request.
- **Order.** KHA-120 `evaluatePolicyChange` accepts the command against the stored
  `TrustState`: owner, binding generation and policy version compare-and-set, and a
  journal keyed by command ID. The ledger write follows, and then `applyPolicyAck`
  records the outcome. A request accepted but not committed, for example after a crash
  or a failed write, is enforced first by the next command, by a retry of the same
  command ID, or by `reconcile` on start.
- **Invariant.** An accepted request is enforced before any newer one is accepted. While
  it cannot be enforced, a new command is refused `unavailable` with nothing written.
  So a retried command whose revision is older than the effective one was enforced, and
  answers `effective` even though a newer request has superseded it since. A trust store
  the ledger has moved past, for example one restored from backup, starts again from the
  ledger and drops its journal.
- **New generation.** The handler writes only revisions for a generation the ledger
  already has a policy for. It does not seed that policy, because the listening
  projection belongs to its own owner. Until something applies one, commands answer
  `unavailable` and the status reports null values.
- **Automation.** Hosted evaluation injects `CLOSED_AUTOMATION` (`automation.ts`), so
  `auto` is refused and acknowledged as rejected with `unavailable`.
- **Pause.** Pause and resume bump the policy version but not `armedAt`, so approved
  releases stay current and continue on resume. A mode change re-arms. Pause holds
  delivery at the claim. It never cancels an active model turn.
- **Status.** `status` reads the enforced version and pause from the dispatch ledger, the
  mode from trust state, any accepted but unenforced request, busy work and its newest
  v1 receipt. It carries no message content, key or authority.
- **Authority.** Nothing in a body is authority. The owner comes from the transport's
  `OwnerAuthority` and must own the ledger's binding. Another owner learns nothing
  beyond `forbidden`.

`registerControls` is `ready` only with a protected transport and its control
dependencies, including a durable `TrustStateStore`. Neither exists yet, so the
runtime keeps controls unavailable. See `tests/integration/controls/README.md`.
