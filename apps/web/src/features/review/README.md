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
  clears it (AE1).
- **`controller.ts`** owns the merged `ReviewData` (view + selection +
  submission) consumed through `useSyncExternalStore` — it mirrors
  `timeline/controller.ts`'s cached-snapshot pattern layered over the
  injected port. Submission state (the current command's lifecycle, its
  `commandId`, adopted `releaseIds`, and any error) stays controller-local,
  not part of the port's cached `ReviewView` — the same split as timeline's
  draft/pending-send state (KTD2). Creates one stable `commandId` per
  submission; `outcome_unknown` reconciles the *exact same* previously-sent
  command object, never a freshly reconstructed one. Revocation
  (`access: 'revoked'`) immediately clears selection, submission and the
  retained last-command, even ahead of a late in-flight response (Failure
  boundaries).
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
- **No participant roster/owner-name lookup**, matching timeline's own scope
  trim — attribution here shows the authenticated `ParticipantView.kind` and
  `displayName` directly, not a resolved owner display name.
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
content remain separately selectable objects, and that adding an
already-selected exact ref is rejected as a no-op rather than stored twice.
`receipt-labels.test.ts` proves `transport_written` is never labeled "read"
or "consumed," and that correlated `context_consumed`/`completed` evidence is
required before claiming agent consumption. `controller.test.ts` proves one
command per submission, that a lost response retains `unknown` and disables a
blind resubmit, that reconciling adopts release IDs from the *same* command
identity, that revocation clears selection/submission/command authority even
ahead of a late `unknown` response, and that a rejected result preserves its
closed-vocabulary error code. `ReviewScreen.test.tsx` renders the real
production components with `react-dom/server` and asserts structure: full
content and its author render before selection (R1), fake control markup in
message content renders as inert escaped text with review's own controls
staying structurally separate, the checkbox reflects controller-owned
selection state (never content), a stale selection shows its own banner and
disables its controls, a revoked view shows its own banner and disables
release, and a released submission shows receipt-derived evidence rather than
inventing consumption from release alone.

`review.browser.spec.ts` (named outside vitest's glob, same convention as
`timeline.browser.spec.ts`) builds a small harness (`browser-harness/`) that
mounts the real `ReviewScreen`/`createReviewController` against a synthetic
in-memory `ReviewUiPort` (no real network, storage, owner authority, or
credentials) and drives it with headless Chromium via Playwright: full
content and author are visible before selection; selecting one item updates
the count without touching the other; a live arrival during selection never
joins it and does not disturb the existing selection, including under the
Selected filter; hiding an item never changes the selection or triggers a
release; releasing the exact selection shows truthful "Released" status with
receipt-derived evidence, never inventing a consumption claim from the
release step alone; and a revoked facade shows an explicit banner and
disables further submission.

## What this does not prove

This is a component-level harness with a synthetic fake `ReviewUiPort`, not
the shipped application against a real owner-authenticated endpoint. It does
not exercise the real `renderMessageContent` renderer wired in by composition
(KHA-134), a real `OwnerAuthority`-issuing backend, real `DeliveryReceipt`
observation over time, or an accessibility audit beyond the specific
assertions above. Composition into the real app and the real content-renderer
wiring are explicitly KHA-134's scope, not this ticket's.
