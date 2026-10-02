# Shell primitives

The signed-in app renders the edge-to-edge Khala frame,
[`ui/khala/KhalaApp`](../ui/khala/KhalaApp.tsx) (RECREATION-SPEC §1): one
full-viewport `.kh-card` with the brand row, list, main and detail columns.
This directory keeps the presentation-only pieces that screens inside that
frame still use. None of them has feature, auth or messaging imports.
`pnpm check:boundaries` enforces the cross-package parts of that boundary
(contracts, packages/*, cross-app imports). It does not yet block a sibling
`apps/web/src/features/*` import into this directory, so that rule is a
review convention, not a checked one.

- `KhalaPageFrame`, `Panel` and `StatusBadge`: page, card and badge markup
  for non-chat screens.
- `theme.ts`: deterministic initial theme resolution and persistence.
- `AiurShell`: a bare `.khala-content-root` wrapper that carries the tokens
  for a screen mounted outside the frame. It renders no topbar or navigation
  in either mode.
- `shell.css`: the shared icon button, dialog, page frame, panel, badge and
  loading styles. Page titles use the UI font; only the wordmark uses the
  logo font.

## What is verified here

`AiurShell.test.tsx`, `primitives.test.tsx` and `shell.test.ts` render the
components with `react-dom/server` or read the stylesheet. They check that no
topbar, navigation or drawer chrome remains, that zero or unknown counts never
render a badge, and that `theme.ts` resolves deterministically when storage
is blocked or invalid.

`shell.browser.spec.ts` builds `browser-harness/`, which mounts `KhalaApp`
with today's list and thread components and synthetic content. It drives the
harness in headless Chromium:

- At 1440×900 the card fills the viewport, the list is 300px, and the page
  never scrolls.
- The body, list head, buttons and list rows compute to "Space Grotesk". Only
  `.kh-brand .wm` computes to Bungee.
- The brand row's theme toggle swaps the tokens, and Log out sits beside it.
- At 1100px the list is 260px.
- At 390px the list view shows the brand row, and the thread view hides the
  list.

`shell.visual.spec.ts` captures the same harness at 1440, 1100 and 390 (list
and thread), in both themes. It runs inside the pinned Playwright image (see
`playwright.visual.config.ts`). The harness loads `brand/fonts.css`, the
offline copies of the design fonts, so baselines never depend on the network.

Run the browser spec with `pnpm --filter @khala/web test:browser`. It needs a
local Chromium.

## What this does not prove

This is a component-level harness, not the shipped application. The
composition tests in `composition/human/` cover the real owner shell.
