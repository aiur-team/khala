# agent-controls

`AgentControlsPanel` lets the owning human see what their connected agent's
delivery policy currently is, request a pause on future automatic delivery,
and tell requested intent apart from connector-confirmed effective state. It
is a browser-facing display and request surface over the KHA-106 delivery
contracts — it owns no policy authority itself.

## Product gate: G-AUTOMATION is not resolved

KHA-126's plan stops short of full launch readiness: `auto` mode, delivery
cancellation, turn budgets, and unattended-lifecycle behavior are all gated on
product decisions (P02/P08/G-AUTOMATION) that have not been made. This
directory implements only the honest, capability-only slice the plan cleared
for build:

- `mode: 'review'` is the only mode this UI ever requests. `'auto'` decodes
  (the wire contract must not change shape when the gate opens) but is never
  offered as a control.
- A pause request (`requestPause`) changes **future delivery policy only**.
  It is never a claim that an in-flight model turn stopped or was cancelled —
  `receipt-labels.ts` and the panel copy are deliberately worded around
  "delivery" and "requested", never "stopped"/"cancelled", even though the
  receipt vocabulary has `cancel_requested`/`cancelled` kinds for delivery
  itself.
- `controlsAvailable` is only ever `true` when both the approved policy and
  the adapter's inspected `HarnessCapabilities` are known to permit it — it is
  never simulated for a capability that was not observed.

Extending this surface to cover the gated behavior is out of scope until a
product owner resolves P02/P08/G-AUTOMATION.

## Ports

`AgentControlsPorts` (`ports.ts`) bundles one browser facade,
`AgentControlsUiPort`:

- `readSnapshot(bindingId)` / `subscribe(bindingId, listener)` — the
  authoritative policy/capability/connection snapshot for one binding.
  `PolicySnapshot.effectiveVersion === null` means no authoritative revision
  has been observed yet; this is never coerced to `0`.
- `submitPolicy(command)` — submits a `PolicySetCommand`. Trusted composition
  (135) attaches `OwnerAuthority` under the current human session outside the
  browser; this port never accepts or exports `OwnerAuthority`, so it cannot
  be used as a general agent tool.

`PolicyAck` (KHA-106) confirms a command's version/connector outcome only —
it carries no `mode`/`paused` fields. `controller.ts` therefore never derives
the *effective* mode or paused flag from an ack; only a subsequent
`AgentControlsSnapshot` push (matching the current binding generation) updates
the effective display. An ack updates the *requested* badge only.

## Command identity and races

`controller.ts` tracks one `latestCommandId` at a time. A response for a
superseded request — the human issued a second command before the first
resolved — is detected by comparing the resolving ack's command against
`latestCommandId`, and discarded. This is the "two browser tabs race" and
"last-response-wins" regression the plan calls out explicitly: a stale ack
must never overwrite state a newer, still-in-flight request will settle.

A binding-generation change on any incoming snapshot (a session was replaced)
clears the pending command and any in-flight acknowledgment immediately — a
new generation never silently inherits a permissive policy from the
superseded binding.

## Setup and disposal

`AgentControlsPanel` owns its `createAgentControlsController` instance via
`useMemo` and disposes it on unmount. A pre-built controller can be injected
through the (test-only) `controller` prop.

## Testing

- `receipt-labels.test.ts` — the receipt-kind-to-label mapping (unit):
  `transport_written`/`harness_queued` never imply `context_consumed`,
  `outcome_unknown` stays distinct, and a malformed/undecodable receipt shows
  a generic unavailable detail without leaking the raw payload.
- `controller.test.ts` — the versioned policy-intent state machine against a
  fake `AgentControlsUiPort` (unit): null-version handling, offline acks
  leaving the prior effective policy visible (AE1), stale-ack rejection, and
  binding-generation resets.
- `AgentControlsPanel.test.tsx` — static markup assertions
  (`react-dom/server`) for scope visibility, disabled-control wording, and
  that the pause affordance never claims delivery stopped or was cancelled.
- `agent-controls.browser.spec.ts` — a real Chromium run (via
  `browser-harness/`) against fabricated, in-memory ports: a full pause
  request → pending → effective round trip with focus retention, and a
  structural check that simulated incoming message text never reaches a
  policy control.

This package has no `jsdom`/testing-library dependency, so interactive and
focus-sensitive behavior is proven in the browser test rather than a
DOM-emulated unit test.
