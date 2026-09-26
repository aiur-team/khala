# agent-controls

`AgentControlsPanel` lets the owning human see what their connected agent's
delivery policy currently is, request a pause (or resume) of future review
delivery, and tell requested intent apart from connector-confirmed effective
state. It is a browser-facing display and request surface over the KHA-106
delivery contracts — it owns no policy authority itself.

A separate **Listening mode** section shows and changes one binding's
requested and effective listening mode (`steer`, `sync`, `async`). See
[Listening mode](#listening-mode) below.

## Product gate: G-AUTOMATION is not resolved

KHA-126's plan stops short of full launch readiness: `auto` mode, delivery
cancellation, turn budgets, and unattended-lifecycle behavior are all gated on
product decisions (P02/P08/G-AUTOMATION) that have not been made. This
directory implements only the honest, capability-only slice the plan cleared
for build:

- `mode: 'review'` is the only mode this UI ever requests. `'auto'` decodes
  (the wire contract must not change shape when the gate opens) but is never
  offered as a control, and a snapshot that already reports `'auto'` is
  labelled "unavailable pending policy decision" rather than presented as a
  live feature.
- A pause/resume request (`requestPause`) changes **future delivery policy
  only**. It is never a claim that an in-flight model turn stopped or was
  cancelled — `receipt-labels.ts` and the panel copy are deliberately worded
  around "delivery" and "requested", never "stopped"/"cancelled", even though
  the receipt vocabulary has `cancel_requested`/`cancelled` kinds for delivery
  itself. Copy never claims "automatic" delivery is live, either: the button
  reads "Resume review delivery", never "Resume automatic review delivery".
- `controlsAvailable` is only ever `true` when the binding is active, the
  viewer is its owner, and both the approved policy and the adapter's
  inspected `HarnessCapabilities` permit it — it is never simulated for a
  capability that was not observed. `support` must not be `'unsupported'`,
  and `existingSession` must be exactly the one evidence-backed route,
  `'khala_hosted_resume'` — `'unknown'` (not investigated) is treated the same
  as `'unsupported'`, never assumed safe by default. The panel always renders
  the exact inspected `support`/`existingSession` states (`capabilityDetail`),
  even when they are what disabled the control, so a human never has to guess
  why. A binding the viewer does not own, or one marked `revoked`, never gets
  an enabled control regardless of capability state.

Extending this surface to cover the gated behavior is out of scope until a
product owner resolves P02/P08/G-AUTOMATION.

## Ports

`AgentControlsPorts` (`ports.ts`) bundles one browser facade,
`AgentControlsUiPort`:

- `readSnapshot(bindingId)` / `subscribe(bindingId, listener)` — the
  authoritative policy/capability/connection/`bindingStatus` snapshot for one
  binding. `PolicySnapshot.effectiveVersion === null` means no authoritative
  revision has been observed yet; this is never coerced to `0`.
  `AgentControlsSnapshot.bindingStatus === 'revoked'` disables every control
  independent of connectivity or capability.
- `submitPolicy(command)` — submits a `PolicySetCommand`. Trusted composition
  (135) attaches `OwnerAuthority` under the current human session outside the
  browser; this port never accepts or exports `OwnerAuthority`, so it cannot
  be used as a general agent tool.
- `submitListeningMode(command)` — the same versioned `ListeningModeCommand`
  the bound agent uses; composition attaches `OwnerAuthority`.
- `submitRouteGrant(command)` — owner-only experimental-route and hard-cancel
  grant/revoke commands. The panel re-reads the snapshot after every result.

`PolicyAck` (KHA-106) confirms a command's version/connector outcome only —
it carries no `mode`/`paused` fields. `controller.ts` therefore never derives
the *effective* mode or paused flag from an ack; only a subsequent
`AgentControlsSnapshot` push (matching the current binding generation, the
requested next version, **and** the requested paused value) updates the
effective display. An ack updates the *requested* badge only.

## Ownership

`AgentControlsConfig.viewerOwnerId` carries the authenticated viewer's own
`OwnerId`. `model.ownerLabelFor` derives "Your agent" or "Another person's
agent (#suffix)" by comparing it against `SessionBinding.ownerId` — never
from a caller-supplied free string. A sibling feature
(`timeline/attribution.ts`) does the equivalent comparison for the message
list, but `scripts/check-boundaries.mjs` forbids importing across feature
directories, so the comparison is reimplemented locally rather than shared.
Controls are disabled whenever `isViewerOwned` is `false`.

## Command identity and races

`controller.ts` tracks one `latestCommandId` at a time. A response for a
superseded request — the human issued a second command before the first
resolved — is detected by comparing the resolving ack's command against
`latestCommandId`, and discarded. This is the "two browser tabs race" and
"last-response-wins" regression the plan calls out explicitly: a stale ack
must never overwrite state a newer, still-in-flight request will settle. A
snapshot resolves a pending request to `'effective'` only when its version,
generation, *and* `paused` value all match what this tab actually requested —
a competing tab's command that coincidentally reaches the same next version
with a different value cannot resolve this tab's request.

A binding-generation change on any incoming snapshot (a session was replaced)
clears the pending command and any in-flight acknowledgment immediately, and
surfaces a "binding replaced, refresh" notice — a new generation never
silently inherits a permissive policy from the superseded binding. A snapshot
reporting an effective version older than the one already displayed is
ignored outright, so out-of-order delivery cannot roll the display backward.

A values-only snapshot match (no command identity in the snapshot) is the
distinct, *tentative* `'matches'` state — never `'effective'`/"confirmed",
which is reserved for this exact command's own terminal ack. It is how a
request whose own ack never resolved decisively (`offline`/`pending`) is
eventually reconciled once the connector reconnects, but it is not proof this
exact command produced the match, so the panel renders it as "current policy
matches your request" rather than claiming confirmation. The command's
identity is kept alive through it rather than retired: if this command's own
ack later arrives `rejected`, `applyAck` still overrides the tentative
`'matches'` instead of the ack being dropped as stale; conversely, a
late-arriving non-terminal ack (`pending`/`offline`) for the same command never
downgrades an already-`'matches'` display, since the snapshot is more current
than that stale in-flight ack. The match also requires
`effectiveMode === 'review'`, since this panel never requests `'auto'` and a
snapshot can otherwise coincidentally agree on version/generation/`paused`
while reporting the unrelated mode.

An `'effective'` ack for this exact command is normally authoritative for the
version/mode/paused it just set without waiting for a separate snapshot to
catch up — except when a newer authoritative snapshot already arrived while
the ack was in flight, in which case the ack's older values are dropped
rather than rolling the display backward. A subsequent request's
`expectedPolicyVersion` is sourced from the *higher* of `latestSnapshot`'s
effective version and this command's own confirmed `'effective'` ack version
— never `latestSnapshot` alone — since a snapshot push can lag behind our own
ack; building the next request from a stale snapshot version would guarantee
a `stale_policy` rejection.

If a later snapshot for the same generation reports an effective version
newer than what this command's own `'effective'` ack confirmed, that ack is
superseded — someone else's request won the race after ours landed. The
panel clears the superseded request's `requestedMode`/`requestedVersion`/
`requestedPaused`/`errorCode` on that snapshot rather than continuing to show
a "confirmed" badge for a version that is no longer current.

## Failure handling

A rejected ack or a submit-time network failure never erases the request: the
requested mode/version/paused fields are preserved (never coerced to `null`)
so a human can see exactly what was asked for and retry with the same
operation identity (AE2). A rejected ack surfaces its closed `errorCode`
alongside a "request failed, refresh" notice; a network failure that never
reached the connector renders as acknowledgment `'unknown'` — genuinely
"outcome unknown" — never as `'offline'`, which is reserved for an ack the
connector actually returned.

Either failure disables the pause/resume control (`controlsAvailable`) until
a fresh authoritative snapshot arrives, rather than letting a second request
race the unresolved first one; `unavailableReason` names this explicitly.
`controller.refresh()` (wired to the panel's "Refresh" button, shown whenever
a notice is present) re-reads the authoritative snapshot and dismisses a
failure notice on arrival. A genuinely unknown-outcome (network) failure also
offers a distinct `controller.retry()` (the panel's "Retry" button): unlike
`refresh`, it resends the *exact same* `commandId` and `expectedPolicyVersion`
rather than starting a new command — appropriate because the outcome is
unknown, not because the server already decided. A `rejected` ack (a
connector decision, e.g. `stale_policy`) offers only Refresh, never Retry,
since resending the identical stale version would just fail again.

## Setup and disposal

`AgentControlsPanel` builds its own `createAgentControlsController` instance
via `useMemo`, keyed on the config's primitive identifiers so cosmetic label
changes don't force a rebuild, and disposes it on unmount or rebuild. When a
controller is injected through the (test-only) `controller` prop, the panel
never builds or disposes one of its own — an injected controller is owned by
its caller.

## Listening mode

Contract: `docs/product/internal-mode/listening-modes.md` ("Honest UI" and
ticket 5, `listening-mode-ui`). This section is separate from the pause/resume
policy control and never uses its owner-only policy port.

- **Data.** `AgentControlsSnapshot.listening` carries the store's
  `ListeningModeView` for the exact binding generation, plus who wrote the
  current version (`view.lastChangedBy`, recorded by the store from the verified
  authority; `lastChange` is only a fallback for `unknown`, decision 42), sibling binding IDs, hard-cancel
  support for the `steer` route, and whether idle delivery is proven. It is
  `null` until the store answers, and the section then offers no control.
- **Label.** Every listening surface repeats `<CLI name> <version> ·
  <short-id>`. The short ID is a digest of the immutable binding ID that
  widens from four characters until no sibling shares it.
- **Primary evidence only.** Only `view.support` (the primary
  interactive-session projection) can make a mode selectable or green. The
  top-level `HarnessCapabilities.evidenceRef` (for example the hosted Codex
  app-server proof) appears only inside a "Secondary evidence" disclosure.
- **Support states.** `proven` is selectable. `experimental` is disabled until
  the owner confirms a route-specific grant beside it. `unsupported`,
  `unknown`, and `blocked_without_wrapper` are disabled with their exact
  reasons. The panel never offers a wrapper action. `async` also needs
  `batch_token_next_call` acknowledgement.
- **Evidence links.** `AgentControlsConfig.evidenceRegistry` maps
  identifier-like references to same-origin paths. Any other reference,
  including a URL-shaped one, is plain text.
- **Stopped or disconnected session.** The label and requested mode stay,
  effective shows `none`, every mode and grant action is disabled, and no badge
  is green. The copy directs the owner to resume or rejoin the CLI.
- **Owner mutation.** Choosing a radio only sets a local draft. "Apply
  listening mode" sends `ListeningModeCommand` with the displayed generation
  and version. On a conflict the controller re-reads the snapshot, keeps the
  choice as an unsubmitted draft, announces the change, and moves focus back to
  the selector. It never retries on its own.
- **Grants.** Experimental-route and hard-cancel grants use separate
  `OwnerRouteGrantCommand` kinds and separate confirmations. Enabling one never
  enables the other, and revoking one never touches the other. A grant whose
  route, harness version, or evidence revision no longer matches is shown as
  expired, names what changed, and needs a fresh confirmation against the
  updated evidence. An open confirmation closes if the evidence changes under
  it.
- **Honest claims.** Until idle delivery is proven the section says "Idle
  agents receive messages only at their next turn." A failed or unknown
  delivery receipt adds a non-green problem line and never changes the
  selector.

## Accessibility

The listening section uses a `fieldset`/`legend` radio group, so arrow keys
move between enabled modes. Each radio's `aria-describedby` points at its
support reason. The listening status region (`role="status"`) is always
mounted and announces requested/effective divergence, conflicts, and grant
results. A grant confirmation takes focus when it opens.

The requested-status region (`role="status"`) stays mounted at all times,
even before any request exists, so a later confirmation is actually announced
by assistive tech rather than appearing only once there is something to say.
The disabled pause button's `aria-describedby` points at the unavailable-
reason paragraph so its id is exposed by name, not just adjacent text.

## Testing

- `receipt-labels.test.ts` — the receipt-kind-to-label mapping (unit):
  `transport_written`/`harness_queued` never imply `context_consumed`,
  `outcome_unknown` stays distinct, and a malformed/undecodable receipt shows
  a generic unavailable detail without leaking the raw payload.
- `controller.test.ts` — the versioned policy-intent state machine against a
  fake `AgentControlsUiPort` (unit): null-version and null/unsupported/
  unknown-capability handling, ownership and revocation gating, offline/
  rejected/network-failure handling (AE1/AE2), stale-ack and stale-snapshot
  rejection, a rejected ack overriding a coincidentally matching snapshot
  instead of being dropped, an `auto`-mode or wrong-version snapshot never
  reaching `'matches'`/`'effective'`, `retry()` reusing the failed command's
  exact identity, the paused-value identity check against a competing tab,
  binding-generation resets, a late `'effective'` ack never rolling the
  display backward past a newer snapshot (and the next request targeting the
  snapshot's version, not the stale ack's), a late non-terminal ack never
  downgrading an already-`'matches'` display, `errorCode` on a non-rejected
  ack, the receipt clearing on generation change, and the exact wire command
  sent (`mode` is always `'review'`).
- `AgentControlsPanel.test.tsx` — static markup assertions
  (`react-dom/server`) for scope visibility, disabled-control wording,
  pause-vs-resume request labelling (including once paused), the rejected/
  notice/refresh/retry affordances, capability-detail rendering, ownership/
  revocation gating, that an injected controller is never rebuilt or leaked
  into touching real ports, and that the pause affordance never claims
  delivery stopped, was cancelled, or that automatic delivery is live.
- `agent-controls.browser.spec.ts` — a real Chromium run (via
  `browser-harness/`) against fabricated, in-memory ports: a full pause
  request → pending → effective round trip verified through the permanently
  mounted `role="status"` live region, with focus retention, and a structural
  check that simulated incoming message text never reaches a policy control.
  A second test drives the listening section: arrow-key selection, a stale
  owner write that conflicts, focus returning to the kept choice with no
  automatic retry, two same-CLI sessions with distinct labels, experimental and
  hard-cancel grants revoked independently, and no green badge after a
  disconnect.
- `controller.listening.test.ts` — the listening projection and commands
  against a fake port with the store's CAS and grant semantics (unit),
  including the three wrong-implementation cases: a hosted Codex proof never
  makes a TUI mode selectable, a disconnected session shows effective `none`,
  and revoking an experimental route never revokes hard cancel.
- `AgentControlsPanel.listening.test.tsx` — static markup for the listening
  section: green only for a proven route on an active session, labels on every
  surface, allowlisted evidence links, blocked-without-wrapper copy with no
  wrapper action, expired consent, and independent revoke actions.

This package has no `jsdom`/testing-library dependency, so interactive and
focus-sensitive behavior is proven in the browser test rather than a
DOM-emulated unit test.
