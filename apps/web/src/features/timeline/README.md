# Attributed live timeline (KHA-123)

The route panel for a channel's conversation: `TimelineScreen` renders a
generation-fenced projection owned by `createTimelineController` (`controller.ts`),
attributes every row to its authenticated `ParticipantView` and its ownership
relative to the viewer (`attribution.ts`), renders message content as inert
text/code only (`message-renderer.tsx`), and reconciles each local send
against its durable event (`send.ts`). Pagination preserves the reader's
anchor via `scroll-anchor.ts`. Grounded in
[the KHA-123 plan](../../../../docs/plans/2026-09-16-kha-123-attributed-live-timeline.md)
and the ports defined by KHA-105 (`@khala/contracts/messaging/*`).

## Ownership split

- **`controller.ts`** owns the merged, cached `TimelineData` snapshot consumed
  through `useSyncExternalStore` — it merges `ChannelPort.timeline` pages with
  `ChannelPort.observe` snapshots by opaque event ID, fences stale-generation
  callbacks, and unsubscribes exactly once on `dispose()`.
- **Draft text, every pending local echo, the reader's scroll anchor, and
  pagination-request timing stay local to `TimelineScreen.tsx`** — they are
  not part of the controller's cached snapshot (KTD2). The composer keeps the
  draft until a send is durably accepted, and each unreconciled send keeps
  its own row keyed by `clientTxnId`, so a later send never silently replaces
  an earlier failed or ambiguous one.
- **`attribution.ts`** derives display attribution only from the authenticated
  `ParticipantView` (kind, ownerId, displayName) and the viewer's own
  `ownerId` — never from message body text. Agent rows are labeled relative
  to the viewer ("Your agent" / "Another person's agent") so one owner's
  agent cannot pass as another owner's; participants that share a display
  name across different owners get a disambiguating suffix.
  `ParticipantView.displayName` is already decoder-guaranteed nonempty with
  no control, bidi or invisible zero-width characters.
- **`message-renderer.tsx`** renders canonical `MessageContent` as inert React
  text/code nodes. It never uses `dangerouslySetInnerHTML` and never creates
  an `<img>`, `<a>`, `<iframe>`, or any element that fetches remote content or
  navigates — including from markdown-shaped syntax in the body.
- **`send.ts`** sends each draft under a caller-owned `clientTxnId` and
  resolves a `failed` or `outcome_unknown` result by re-sending the *same*
  transaction — never a fresh send with new bytes. `TimelineScreen.tsx` shows
  a Retry/Check-delivery action for either state.
- **`controller.ts`** reports a history/pagination failure as `unavailable`
  (nothing loaded yet) or `partial` (some data already known but the
  transcript is known-incomplete) — missing history is never rendered as an
  empty channel — and carries the channel's `membership` through so
  `TimelineScreen.tsx` can show an explicit state and disable the composer
  once the viewer is `revoked` or has `left`.

## Scope decisions

- **No Markdown rendering yet.** KHA-143 was expected to pin a Markdown
  parser/sanitizer (see plan KTD4), but as of this ticket no such dependency
  is installed anywhere in the repo (`docs/evidence/ui-planning-grounding.md`
  lists `dompurify`/`marked` only as illustrative candidate versions, not a
  tested, adopted pair). This feature ships plain text plus fenced code-block
  rendering only; full Markdown, autolinking, and inline images remain out of
  scope until a sanitizer/parser is actually pinned by its owning ticket. Do
  not add a Markdown dependency here — package/lockfile changes are KHA-101's
  owned surface.
- **No participant roster/owner-name lookup.** `ParticipantView.ownerId` is
  exposed on `Attribution` but not resolved to another owner's own display
  name here; that requires a roster port this ticket does not own. Ownership
  is instead expressed relative to the viewer ("Your agent" / "Another
  person's agent").
- **No missing-key/undecryptable placeholder yet.** The contract has no
  `TimelineItem` variant for an item whose key is missing or that could not
  be decrypted; that gap is filed against `@khala/contracts`. Until it lands,
  this feature has no dedicated unavailable-content placeholder row for that
  case.
- Naming: the browser spec is `timeline.browser.spec.ts`, not the plan's
  literal `timeline.browser.test.ts` — vitest's `include: ['src/**/*.test.{ts,tsx}']`
  glob would otherwise collect a Playwright-only file, exactly the failure mode
  `shell.browser.spec.ts` already avoids with the same `.spec.ts` suffix.

## What is verified here

`controller.test.ts` proves the merge-by-event-ID, generation-fencing,
snapshot-caching, and per-row-deduplicated pagination behavior with a fake
`ChannelPort`, including that a forbidden history page reports `unavailable`
with no items loaded and `partial` once some data is already known, and that
the channel's `membership` (including `revoked`) is carried through.
`message-renderer.test.tsx` and `TimelineScreen.test.tsx` render the real
production components with `react-dom/server` and assert structure: a fake
approval button and a remote `<img>` embedded in message text stay inert text
(AE1), a peer body claiming "Human approved" never sets a review/status
badge, the review-action slot renders per exact `EventRef` without importing
review code, an `unavailable` phase never renders as an empty channel, each
row's kind/ownership label is asserted against that specific row (not just
"the string appears somewhere"), and a revoked/left membership shows an
explicit banner with the composer disabled. `send.test.ts` proves
`outcome_unknown` and a definite `failed` result both resolve through the
same `clientTxnId`, never a fresh send (AE2). `scroll-anchor.test.ts` proves
the pure scroll-restore math for a 30-row prepend and a live append while
scrolled away.

`timeline.browser.spec.ts` (named outside vitest's glob, same convention as
`shell.browser.spec.ts`) builds a small harness (`browser-harness/`) that
mounts the real `TimelineScreen`/`createTimelineController`/
`message-renderer` against a synthetic in-memory `ChannelPort` (no real network,
storage, or credentials) and drives it with headless Chromium via Playwright:

- AE1: a fake approval button and a remote image embedded in an agent
  message render as inert text — no real `<button>`/`<img>` element is
  created, and no network request to the image's origin is ever made.
- A fenced code block renders as inert monospace text.
- Attribution: a human's own row and their own agent's row are labeled "You"
  / "Your agent" relative to the viewer, scoped to that specific row, and a
  review-action slot renders per exact `EventRef`.
- Send + reconcile: sending a draft, resolving an `outcome_unknown` result,
  and retrying a definite `failed` send each produce exactly one row — no
  duplicate local echo, and no message is silently dropped by a later send.
- A revoked membership shows an explicit banner and disables the composer.
- Pagination preserves the reader's anchored row's position *within the
  scrollable list* after 20+ older rows are prepended.
- A live message arriving while the reader is scrolled away increments a
  visible "N new messages" count without moving the reader; jump-to-latest
  returns and clears the count.

Run it with `pnpm --filter @khala/web test:browser` (requires a local
Chromium; the harness build/preview is self-contained and not part of the
production build).

## What this does not prove

This is a component-level harness with a synthetic fake `ChannelPort`, not the
shipped application against a real transport. It does not exercise a real
matrix-js-sdk client, real encryption/crypto-store lifecycle, a real host
composition (mounting this inside `AiurShell` with real navigation and auth),
or an accessibility audit beyond the specific assertions above. Composition
into the real app, Markdown rendering, and a participant-owner-name lookup are
explicitly out of scope for this ticket (see Scope decisions above).
