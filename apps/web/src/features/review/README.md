# Recipient review queue (KHA-125)

The route panel a human uses to release exact pending message versions to
their own agent: `ReviewScreen` renders a full inert preview per pending
`TimelineItem`, exact-selection checkboxes (`selection.ts`), and one explicit
release action wired through `createReviewController` (`controller.ts`) to an
injected `ReviewUiPort` (`ports.ts`). Grounded in
[the KHA-125 plan](../../../../docs/plans/2026-09-16-kha-125-recipient-review-ui.md)
and the ports defined by KHA-105 (`@khala/contracts/messaging/*`) and KHA-106
(`@khala/contracts/delivery/*`).

## Ownership split

- **`ports.ts`** defines `ReviewUiPort`/`ApprovalUiResult` — a browser-only
  injected port. Its `approve` operation accepts only an `ApprovalCommand`; it
  never accepts an `OwnerAuthority` from browser state (KTD2). KHA-134 supplies
  the real adapter that authenticates the human and attaches that authority
  server-side; this ticket's tests supply synthetic ports.
- **`selection.ts`** is pure, React-free exact selection: bound to exact
  `EventRef` identity and content digest plus a captured binding
  generation/policy version, never row numbers or mutable rendered text
  (KTD1). A live arrival never joins an existing selection; once a captured
  selection no longer matches the current pending items or binding/policy
  context it moves to `stale` and stays there until the human explicitly
  clears it (AE1). `addRef` also rejects, at the model layer, any ref that is
  not currently present *and* readable in the given `pending` list — an
  unavailable placeholder or a ref that has simply left the pending set is
  never accepted regardless of what the screen happens to show.
- **`attribution.ts`** is a local, pure copy of timeline's own
  `ownershipLabel`/`buildDisplayNameResolver` pattern (see "Attribution
  follows the same rules..." below).
- **`controller.ts`** owns the merged `ReviewData` (view + selection +
  submission) consumed through `useSyncExternalStore` — it mirrors
  `timeline/controller.ts`'s cached-snapshot pattern layered over the
  injected port. Submission state (the current command's lifecycle, its
  `commandId`, adopted `releaseIds`, and any error) stays controller-local,
  not part of the port's cached `ReviewView` — the same split as timeline's
  draft/pending-send state (KTD2). Creates one stable `commandId` per
  submission; `outcome_unknown` always adopts the commandId of the command
  actually sent, never a value read back from the port's result. The command's
  `selection` is reordered into current display (pending) order before it is
  sent, never left in click order. Revocation (`access: 'revoked'`) sanitizes
  the cached `ReviewView` itself — clearing `pending` at the source, not just
  wherever it happens to render — and immediately clears selection, submission
  and the retained last-command, even ahead of a late in-flight response
  (Failure boundaries). A server-observed `stale_policy`/`stale_binding`/
  `stale_content` rejection moves the selection into the same `stale` state a
  locally-detected staleness uses, so Release is disabled the same way rather
  than left active beside a raw error code.
- **`receipt-labels.ts`** maps a `DeliveryReceipt.kind` to a label without
  ever inventing an ordinal progress bar over the closed `ReceiptKind`
  vocabulary, and never labels `transport_written` as "read" or "consumed" —
  only `context_consumed`/`completed` count as correlated evidence (U3).
- **`ReviewItem.tsx`** renders one pending row: full content through an
  *injected* `renderContent` function, plus review-owned checkbox and Hide
  controls as structural DOM outside that render call, so message body
  content can never fabricate or invoke a control (KTD4).
- **`ReviewScreen.tsx`** composes the list, filter chips (All/Selected), a
  stale-selection banner with an explicit Reselect action, a revoked-access
  banner, and the release action bar showing submission status and — once
  released — per-`releaseId` receipt-derived evidence.

## Why `renderContent` is an injected prop, not a timeline import

U2's plan text says to reuse the safe content renderer "through an injected
render slot, avoiding direct timeline internals import." `scripts/check-
boundaries.mjs` enforces this structurally: any file under
`apps/web/src/features/<X>/` that resolves an import into
`apps/web/src/features/<Y>/` (including via the `@khala/web/features/*`
package export) fails as a "sibling feature import," with no exception for
composition-looking code inside a feature directory. `ReviewScreen`/
`ReviewItem` therefore accept `renderContent: (content: MessageContent) =>
ReactNode` as a prop — symmetric with `TimelineScreen`'s own injected
`renderReviewAction` slot — and a composition root outside
`apps/web/src/features/` (KHA-134's job) wires the real
`timeline/message-renderer.tsx`'s `renderMessageContent` in. This feature's
own browser harness therefore uses a synthetic plain-text `renderContent`,
proving this feature's render-slot isolation, not the real renderer's own
sanitization (already proven by `timeline/message-renderer.test.tsx`).

## Scope decisions

- **No separate preview/list pane split.** Aiur's decision-inbox pattern
  (KTD4 reference; source lives only in the sibling `../aiur` repo, not here —
  see `docs/evidence/ui-planning-grounding.md`) uses a list-plus-detail-panel
  layout. This feature instead shows full content inline per row in a single
  always-visible list: every pending item already satisfies R1 ("inspect full
  permitted content ... before selecting") without a second pane, and a
  master/detail split adds real complexity with no corresponding requirement.
  `review.css` still adjusts layout at a 390px breakpoint for narrow viewports.
- **No dismiss/close action that removes a pending item from the backlog.**
  Only "Hide" exists, and it is local-only (a `useState` set in
  `ReviewScreen`, never touching `selection.ts` or `controller.ts`) — closing,
  hiding, or keeping a review item can never authorize delivery, and hiding
  never removes it from another filter view or from what a future session
  would see (KTD4).
- **Attribution follows the same rules as timeline's `attribution.ts`**
  (`attribution.ts` here is a local, pure copy — a sibling-feature import would
  trip `check-boundaries.mjs`'s "sibling feature import" rule, the same
  constraint `renderContent` works around above). `ReviewView.viewerOwnerId`
  plus each pending item's `ParticipantView.kind`/`ownerId` label a row "Your
  agent" / "Another person's agent" / "You" / "Human", and
  `buildDisplayNameResolver` appends a short owner suffix only to display
  names that collide across owners. There is still no roster port to resolve
  another owner's *own* display name — ownership is expressed relative to the
  viewer, not by naming the other owner.
- **`bindingId`/binding context is typed with the branded `BindingId`**, not
  the plan illustration's plain `string` — `SelectionSnapshot.bindingId` is
  `BindingId` from `@khala/contracts/delivery/ids`. `BindingId` is
  structurally a branded `string`, so this is a strictly narrower, compatible
  reading of the plan's illustrative shape, not a contract deviation.
- Naming: the browser spec is `review.browser.spec.ts`, not the plan's
  literal `review.browser.test.ts` — matching the same `.spec.ts` convention
  `timeline.browser.spec.ts` and `shell.browser.spec.ts` already use to stay
  outside vitest's `include: ['src/**/*.test.{ts,tsx}']` glob.

## What is verified here

`selection.test.ts` proves AE1 (an edited event or a binding-generation/
policy-version change invalidates a captured selection), that a new arrival
never joins an existing selection, that two events sharing identical body
content remain separately selectable objects, that adding an already-selected
exact ref is rejected as a no-op rather than stored twice, and that the model
itself — not just the screen — rejects a ref that is not currently present
and readable in `pending`, including an unavailable/withheld placeholder.
`receipt-labels.test.ts` proves `transport_written` is never labeled "read"
or "consumed," and that correlated `context_consumed`/`completed` evidence is
required before claiming agent consumption. `controller.test.ts` proves one
command per submission, that a lost response retains `unknown` and disables a
blind resubmit, that reconciling adopts release IDs from the *same* command
identity, that revocation clears selection/submission/command authority even
ahead of a late `unknown` response — including against a fake port that does
*not* itself empty `pending`, proving the controller clears the protected
preview at its own source — that a definite rejection preserves its
closed-vocabulary error code, that a server-observed `stale_policy`/
`stale_binding`/`stale_content` rejection moves the selection into the same
`stale` state as a locally-detected staleness, that an `outcome_unknown`
result always adopts the commandId of the command actually sent rather than
one read back from the result, that the command's `selection` contains only
the chosen refs (never every pending item) in display order (never click
order), that an unrelated port change never reconciles an `unknown`
submission on its own, and that toggling a ref absent from the current
pending set is rejected by the controller itself. `ReviewScreen.test.tsx`
renders the real production components with `react-dom/server` and asserts
structure: full content and its author render before selection (R1), fake
control markup in message content renders as inert escaped text with
review's own controls staying structurally separate, the checkbox reflects
controller-owned selection state (never content), a stale selection shows
its own banner and disables its controls, a revoked view shows its own
banner and disables release, a released submission shows receipt-derived
evidence rather than inventing consumption from release alone, own-vs-other
agent attribution and same-name disambiguation follow the #72 rules, each
checkbox carries an accessible name beyond the bare author name, and an
unavailable item renders as a disabled placeholder with its withheld reason
instead of being dropped silently.

`review.browser.spec.ts` (named outside vitest's glob, same convention as
`timeline.browser.spec.ts`) builds a small harness (`browser-harness/`) that
mounts the real `ReviewScreen`/`createReviewController` against a synthetic
in-memory `ReviewUiPort` (no real network, storage, owner authority, or
credentials) and drives it with headless Chromium via Playwright, across
several focused specs: full content and author are visible before selection;
selecting one item updates the count without touching the other; a live
arrival during selection never joins it and does not disturb the existing
selection, including under the Selected filter; hiding an *unselected* item
never changes the selection or triggers a release; hiding a *selected* item
deselects it, so Release can never carry a row that is no longer visible;
submitting the exact remaining selection shows a truthful "Released" status
with receipt-derived evidence, never inventing a consumption claim from the
release step alone; a revoked facade shows an explicit banner and disables
further submission; editing a selected pending item's body, and separately
bumping the binding generation, each mark the captured selection stale end
to end through the real harness (AE1) and Reselect clears it; a long message
renders in full (not truncated) and its checkbox responds to keyboard
selection (Space); and switching to a 390px viewport preserves the exact
selection and its count.

## What this does not prove

This is a component-level harness with a synthetic fake `ReviewUiPort`, not
the shipped application against a real owner-authenticated endpoint. It does
not exercise the real `renderMessageContent` renderer wired in by composition
(KHA-134), a real `OwnerAuthority`-issuing backend, real `DeliveryReceipt`
observation over time, or an accessibility audit beyond the specific
assertions above. Composition into the real app and the real content-renderer
wiring are explicitly KHA-134's scope, not this ticket's.
