# `@khala/policy/trust`

Pure trust and re-arm transitions for one recipient binding (KHA-120). Import from
`@khala/policy/trust/index`. Nothing here persists, sends or reads plaintext:
trust-controls composition (KHA-135) stores the returned `TrustState` with its own
compare-and-set and delivers the returned effects. Durable storage (KHA-115), dispatch
(KHA-121) and delivery composition (KHA-134) own their receipts.

## Requested is not effective

`evaluatePolicyChange` turns an owner's `PolicySetCommand` into a new *requested*
revision and a `publish_policy` effect. The control service accepting it is not
enforcement. Only `applyPolicyAck` with a connector acknowledgment that echoes the
binding, its current generation, the accepted command id and that command's version
moves the *effective* revision. `trustView` reports `requested` until then, so a
re-arm made while the connector is offline never shows as review being active.

Re-arming does not retract anything. Content the connector already released under an
earlier auto revision was delivered; the view says what is enforced now, not what was
recalled.

## Authority and concurrency

- Only an `owner` actor whose `OwnerAuthority` names the binding owner can change
  policy. `peer` and `model` actors are refused and not journaled, so they cannot
  claim a command id.
- The command must name the current binding generation and policy version. A conflict
  is `stale_binding` or `stale_policy`: refresh and decide again, never last-write-wins.
- A retried command id returns its first outcome, refusals included; reuse with other
  input is `idempotency_conflict`. A fresh decision uses a new command id.
- Effective state only moves forward. A late ack for an older request cannot roll back
  a newer one. If the connector really enforced an older request, it becomes effective
  while the newer request stays requested, because hiding it would overstate review.
- `applyRebind` starts a new generation from a fresh review baseline with a bumped
  version. Trust is never inherited, and acks for the old generation are ignored. A
  command accepted before the rebind and replayed after it is `stale_binding`, not a
  success for the old generation.
- Composition passes the binding's `BindingStatus` from the control plane. Revocation is
  terminal: on a `revoked` binding every policy change, re-arm and rebind is refused
  with `binding_revoked`, and automatic release holds. The control-plane disable
  (KHA-128) is defense in depth, not the only guard.

## Automatic release

`evaluateAutomaticRelease` decides for one event at a time. It releases only when the
connector confirmed the latest policy since connecting, that policy is the effective
unpaused `auto` revision for the current binding generation, the author is the one peer
that revision names (never the recipient agent), the event arrived after that revision
took effect, and the causal depth and caller's budget allow it. Otherwise it returns a
content-free `held` reason. A release carries the same approval, binding, policy and
event fields as a KHA-119 release; `approval` names the policy command that authorised
it. An event that already has a release returns that identity instead of a new one.

## Backlog

Activating `auto` covers future events only: anything that arrived under an earlier
revision is held as `backlog`. Releasing it is a separate exact owner selection through
`ApprovalCommand` and `releaseFromApproval`. The two are distinct operations with two
outcomes, never atomic. Approve the backlog before activating, or the approval fails
`stale_policy` once activation bumps the version. New events never join an earlier
selection.

## G-AUTOMATION

Budget, loop limit, human triggers and offline expectations are unresolved launch
decisions for the hosted product. Automation authority is therefore an explicit
dependency: `evaluatePolicyChange` and `evaluateAutomaticRelease` take an
`AutomationAuthority` from server composition, and there is no global default. Hosted
composition (`apps/connector/src/composition/controls/automation.ts`) injects
`CLOSED_AUTOMATION`, whose `approvedAutomation()` returns `null`, so every hosted
`auto` request is refused as `automation_gated` and every event is held as
`automation_gated`. A raw config passed where the authority belongs stays closed.

Only the internal app's local composition
(`apps/internal/src/composition/local-automation/`) supplies a bounded authority, built
from the explicitly injected `LOCAL_AUTOMATION_LIMITS`. It passes only
`maxCausalDepth` into this module; the per-root job budget and the busy-worker wait sit
on top, after these checks, so stop, pause, loop and budget holds always win.
`scripts/check-boundaries.mjs` lets only the internal composition import that provider
or the local limits profile, and fails if any web, control or connector graph reaches
`apps/internal`, the profile, or the provider's `khala:local-automation-authority`
marker.

The automatic-release rules above describe behavior under a bounded authority. Their
tests inject example limits that are not approved values; `gate.test.ts` checks the
closed authority. `budgetRemaining` is supplied by the caller and not bounded here; the
local provider derives it from its per-root ledger. Real connector
acknowledgment and reconnect behavior are proven by KHA-135 and KHA-138, not by these
unit tests. Test builders live in `packages/policy/test/trust/`, outside the exported
and built `src/` tree.
