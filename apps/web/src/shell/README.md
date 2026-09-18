# Aiur-branded shell (KHA-107)

`AiurShell` + `KhalaPageFrame` implement the Aiur dashboard chrome/content
split described in
[the KHA-107 plan](../../../../docs/plans/2026-09-16-kha-107-aiur-dashboard-shell.md),
grounded in `docs/evidence/ui-planning-grounding.md` and the already
browser-tested fixture behind
[`docs/evidence/client-reuse.md`](../../../../docs/evidence/client-reuse.md)
(KHA-143). `Panel`, `StatusBadge` and `theme.ts` are presentation-only
primitives with no feature, auth or messaging imports (enforced by
`pnpm check:boundaries`).

- `mode: "standalone"` renders the full topbar/nav/main chrome.
- `mode: "hosted-content"` renders only the children — a future embedding
  host supplies its own chrome and the single navigation/main landmark.

## What is verified here

`AiurShell.test.tsx` and `primitives.test.tsx` render the real production
components with `react-dom/server` and assert structure: exactly one
topbar/nav/main in standalone mode, no shell chrome (and so no duplicate
landmark) in hosted-content mode, zero/unknown counts never render as a
backlog badge, and `theme.ts` resolves deterministically with blocked or
invalid storage.

`shell.browser.test.ts` builds a small harness (`browser-harness/`) that
mounts the same production components with synthetic content (a long
navigation label, a long wrapped message, no real credentials or endpoints)
and drives it with a real headless Chromium via Playwright:

- Desktop (1440×1000): single topbar/nav/main, count badge visible.
- Navigation collapse: keyboard focus stays on the toggle, the toggle
  remains visible, and it never lands on a hidden element.
- Theme swap: `data-theme` flips and the toggle's own label updates.
- Viewports 960px/959px (the source breakpoint on each side), 390×844,
  360×780, 844×390 landscape, and a 720×500 stand-in for 200% zoom: no
  horizontal overflow, exactly one navigation landmark, and the review
  control stays visible and reachable at every size.

Run it with `pnpm --filter @khala/web test:browser` (requires a local
Chromium; the harness build/preview is self-contained and not part of the
production build).

## What this does not prove

This is a component-level harness, not the shipped application. It does not
exercise real navigation items, real review/approval wiring, a real host
composition, or an accessibility audit beyond the specific keyboard/focus/
overflow assertions above. Composition (mounting `AiurShell` with real
navigation, auth and review state) is owned by a later ticket (KHA-132 per
the plan); this ticket does not add or claim that wiring.
