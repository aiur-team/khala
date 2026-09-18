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
  content can never fabricate or invoke a control (KTD4). The checkbox's
  `aria-label` includes a preview of the body, but — unlike `displayName`,
  which is decoder-guaranteed free of control/bidi/invisible characters —
  the body carries no such guarantee, so that preview is stripped of the
  same character classes before it reaches the accessible name. The preview
  is taken by Unicode code point, not `String.slice`'s UTF-16 code units, so
  the 60-character cutoff can never split a surrogate pair. Hide is disabled
  while a submission is in flight or unresolved: hiding a selected row then
  would leave its ref selected-but-invisible, since `toggleSelect` is itself
  a no-op during that window, with no way back short of a full Reselect.
- **`ReviewScreen.tsx`** composes the list, filter chips (All/Selected), a
  stale-selection banner with an explicit Reselect action, a revoked-access
  banner, and the release action bar showing submission status and — once
  released — per-`releaseId` receipt-derived evidence. `toggleSelect` is also
  a no-op whenever access isn't `ready`, not only during a submission, so
  hiding a selected row while access is `unavailable` can desync a selected
  ref from what remains visible the same way; the stale-selection banner and
  Reselect action cover that desync too (`selectedRefs.length !==
  selection.refs.length`), not only an explicit `stale` selection phase. The
  live-arrival announcement fires on any growth of the pending count while
  already `ready`, including a first arrival into a queue that had already
  drained to empty — but never on `pending` repopulating as part of
  recovering into `ready` itself (the initial load, or a return from
  `loading`/`unavailable`/`revoked`), which must never be misread as a live
  arrival however many items come back with it.

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
and readable in `pending`, including an unavailable/withheld placeholder (using
that placeholder's own digest-less ref, so the rejection is pinned to the
`isReadableItem` guard rather than an incidental digest mismatch against a
separately constructed `EventRef`).
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
agent attribution and same-name disambiguation follow the #72 rules — scoped
per row, since a whole-document substring check cannot tell an inverted
ownership comparison from a correct one when both label strings still appear
somewhere on the page — each checkbox carries an accessible name beyond the
bare author name, that accessible name strips control and bidi characters out
of the body preview even though the same characters still render in the
visible, inert body (individually, for every character class the sanitizer
claims to cover — the isolates, the other bidi-embedding controls, the
zero-width characters, the LTR/RTL marks, and the BOM — not just the two
characters a narrower regex would also pass), that the preview never splits a
surrogate pair at its 60-character cutoff, Hide is disabled on a row while any
submission is in flight or unresolved, and an unavailable item renders as a
disabled placeholder with its withheld reason instead of being dropped
silently.

`review.browser.spec.ts` (named outside vitest's glob, same convention as
`timeline.browser.spec.ts`) builds a small harness (`browser-harness/`) that
mounts the real `ReviewScreen`/`createReviewController` against a synthetic
in-memory `ReviewUiPort` (no real network, storage, owner authority, or
credentials) and drives it with headless Chromium via Playwright. The
harness's default pending set covers the full attribution matrix — a human
and an agent owned by the viewer, and a human and an agent owned by someone
else — plus a `pushOutcomeUnknownTarget` helper that parks a submission in
`unknown` durably (the only reliable way to observe in-flight UI state, since
the fake port otherwise resolves synchronously), `goUnavailable`/`restoreReady`
to drive an access transition without touching `pending`, and `goLoading`/
`finishLoading` to simulate `pending` genuinely emptying out while `loading`
and repopulating once `ready`. Specs cover: full content
and author are visible before selection; selecting one item updates the
count without touching the other; a live arrival during selection never
joins it and does not disturb the existing selection, including under the
Selected filter; hiding an *unselected* item never changes the selection or
triggers a release; hiding a *selected* item deselects it, so Release can
never carry a row that is no longer visible — proven both end to end and, in
a second spec, isolated from the visible-count guard that would otherwise
mask a missing deselection (hiding one of *two* selected items and requiring
Release to re-enable for the one real deselection left, since the guard alone
can't explain a re-enabled Release without an actual `toggleSelect(false)`);
submitting the exact remaining selection shows a truthful "Released" status
with receipt-derived evidence, never inventing a consumption claim from the
release step alone; a revoked facade shows an explicit banner, disables
further submission, and removes the protected preview bodies themselves, not
just covers them with the banner; editing a selected pending item's body,
and separately bumping the binding generation, each mark the captured
selection stale end to end through the real harness (AE1) and Reselect
clears it; an agent-authored row is labeled "Your agent" for the viewer's own
agent and "Another person's agent" for someone else's, cross-checked so
neither row also carries the other's label; Hide is disabled on every row —
not just the submitted one — while a submission is in flight or unresolved;
hiding a selected row while access is `unavailable` — where `toggleSelect`
no-ops the same way it does during a submission, but Hide itself stays
enabled — desyncs the selection from what's visible without a full end-to-end
reproduction being masked by any single guard, and once access recovers to
`ready` the Reselect banner appears and clears it, rather than leaving
Release stuck disabled at a phantom count with no way out; recovering into
`ready` (via the harness's dedicated `goLoading`/`finishLoading`) never
announces the resulting repopulation of `pending` as a live arrival, even
though a live arrival into a queue that has drained to empty while already
`ready` (not just the transition into readiness) is still announced; a long
message renders in full (not truncated) and its checkbox responds to
keyboard selection (Space); and switching to a 390px viewport preserves the
exact selection and its count.

## What this does not prove

This is a component-level harness with a synthetic fake `ReviewUiPort`, not
the shipped application against a real owner-authenticated endpoint. It does
not exercise the real `renderMessageContent` renderer wired in by composition
(KHA-134), a real `OwnerAuthority`-issuing backend, real `DeliveryReceipt`
observation over time, or an accessibility audit beyond the specific
assertions above. Composition into the real app and the real content-renderer
wiring are explicitly KHA-134's scope, not this ticket's.
