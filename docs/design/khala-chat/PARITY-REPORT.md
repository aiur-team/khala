# Khala design-parity report (KM-186)

| | |
|---|---|
| Date | 2026-10-02 |
| Commit | `aa8a5443` (branch `aiur/872-km-186-design-parity`, on `main` at `d4d63954`) |
| Environment | Linux 7.1.4 (Arch), Node 24.18.0, `@playwright/test` 1.63.0 bundled Chromium (Chrome for Testing 153.0.8010.12, headless shell), `deviceScaleFactor: 1`, Google Fonts loaded over the network |
| Spec | `apps/web/src/ui/khala/parity.browser.spec.ts`, masks in `apps/web/src/ui/khala/parity-masks.ts` |
| Run | `pnpm --filter @khala/web test:browser` (or `node --conditions=khala-source --import tsx --test apps/web/src/ui/khala/parity.browser.spec.ts` from `apps/web`) |
| Result | 206 checks pass and 43 are **blocked** (`todo`, each with its owner): 40 screens and 3 event-dot computed styles. 3 are skipped (`.kh-id`), and nothing fails. Fonts, tokens and every behaviour check pass. |
| Operator sign-off | **Pending.** Two operator decisions are open (see [Open items](#open-items)). |

The spec checks the KM-188 fixture (`apps/web/conversation-fixture.html`) against the real Claude Design (`source/Aiur Dashboard.html`, re-captured by `reference/capture.mjs`), following RECREATION-SPEC §25. Each run writes diff images, fixture screenshots and `results.json` to `apps/web/test-results/parity/` (gitignored). The tables below come from that file.

## How the checks work

- **References.** I re-captured them on the machine that runs the comparison, using the same bundled Chromium. Step 1 of the ticket uses `PLAYWRIGHT_CORE_PKG=… node docs/design/khala-chat/reference/capture.mjs`; that run produced 66 shots with 0 page errors.
- **Reference fix.** The dashboard sets `html { scrollbar-gutter: stable }` (`source:157`), so every full-bleed capture was 15px narrower than its viewport: 1425 of 1440 px, and 375 of 390 px. The full-bleed target fills the viewport (§1.3). So `reference/fullbleed-inject.css` now resets `scrollbar-gutter: auto`, and the screens and `computed-styles.json` were re-captured with it. This is the only edit outside the ticket's write surfaces in the reference lane; the references are still produced only by `capture.mjs`.
- **Screens (§25.4).** For each width × theme × state, the spec opens the design page with the same steps as `capture.mjs` and resolves every mask's selectors to their visible boxes there. It then screenshots the fixture and paints those boxes magenta on both images. A pixel differs when any channel differs by more than 16. The threshold is `diffPixels / totalPixels ≤ 0.02`.
- **Fixture states.**
  - The design's Release thread ends with the viewer's unsent message, so every thread state uses `?failed=1`.
  - At one-pane widths (≤900 px), the capture opened the channel by clicking it, which shows the thread from the top. The spec scrolls the fixture thread to the top to match.
  - At 1100 px and wider, both show the latest messages.
- **Reserved space.** Two omitted elements sit in flow at the start of a scroll container: the `.kh-ask` prompt (sticky at the top of the thread) and the roster Requests group. Leaving them out moves everything after them. While the design container is scrolled to the top, the spec measures the element's outer height there and prepends an empty spacer of that height to the fixture container. The mask then covers the spacer's area on both images. The spacer is only for the comparison; the product renders nothing there.
- **Screen gate on CI.** The screen tests skip when `CI` is set: the references only match the capture machine's rasteriser. A CI gate is a follow-up for the Executor (the ticket's non-goal).
- **Known blocked items.** Every failing check is listed in `KNOWN_BLOCKED` in the spec, with its owner (a ticket or an Executor decision). Those checks run as `todo`, so they report without failing the suite.

## Masks

Each mask is one §22 "Omit" element visible in the design. None covers a region M1 renders.

| Mask | Design selector(s) | §22 row | Reserves space |
|---|---|---|---|
| `kh-ask` | `.kh-ask` | `.kh-ask` "Your agent?" adoption — Omit | yes: `.kh-thread`, when the thread is at its top |
| `kh-badge` | `.kh-head .kh-badge` | Header request badge, roster Requests group, approve/decline — Omit | |
| `roster-requests` | `.kh-roster-in > .kh-rg:has(.kh-req)` | Header request badge, roster Requests group, approve/decline — Omit | yes: `.kh-roster-in` |
| `kh-crw` | `.kh-crw` | Admin crown — Live if the channel creator is known, else omit (the fixture has none) | |
| `kh-rai-p` | `.kh-rai-p` | Progress bar and % (`.kh-rai-p`, `.kh-d-agent > i`, Working on) — Omit | |
| `kh-st` | `.kh-st` | Agent status dot `.kh-st` — omit when `unknown` | |
| `kebab` | `.kh-keb` | Remove human/agent kebabs, `.kh-confirm` — Omit | |
| `gear` | `.kh-hacts [data-kh-act="settings"]` | Settings (gear) popover, Delete channel, Leave menu — Omit | |
| `state-channels` | `[data-kh-convo="infra"]`, `[data-kh-convo="old-launch"]`, `[data-kh-convo="design-crit"]` | `.dead` rows, state cards pending/deleted/removed/used — Omit | |
| `kh-react` | `.kh-react` | `.kh-react` — Omit (not visible in any captured state) | |
| `detail-aiur` | `.kh-d-sec:has(> .kh-d-bar)`, `.kh-d-sec:has(> .kh-d-kv)`, `#kh-d-open` | Detail: Working on, Epic/Phase/Status/Runtime/Progress kv, Open ticket — Omit | |
| `kh-d-agent-pct` | `.kh-d-agent > i` | Progress bar and % — Omit | |

## Results

### Screens

| Width | Theme | State | Diff ratio | Result | Masks applied | Reserved space | Diff image |
|---|---|---|---|---|---|---|---|
| 1440 | dark | thread | 0.0778 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-dark-thread.diff.png` |
| 1440 | dark | roster | 0.0239 | blocked | kh-ask, kh-badge, roster-requests, kh-crw, kh-rai-p, kh-st, kebab, gear, state-channels | .kh-roster-in 123px | `test-results/parity/1440-dark-roster.diff.png` |
| 1440 | dark | chips | 0.0669 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-dark-chips.diff.png` |
| 1440 | dark | detail-agent | 0.1270 | blocked | kh-ask, kh-badge, gear, state-channels, detail-aiur | — | `test-results/parity/1440-dark-detail-agent.diff.png` |
| 1440 | dark | detail-human | 0.1398 | blocked | kh-ask, kh-badge, gear, state-channels, kh-d-agent-pct | — | `test-results/parity/1440-dark-detail-human.diff.png` |
| 1440 | dark | pop-new | 0.0701 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-dark-pop-new.diff.png` |
| 1440 | dark | pop-invite | 0.0839 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-dark-pop-invite.diff.png` |
| 1440 | dark | pop-add-agent | 0.0315 | blocked | kh-ask, kh-badge, roster-requests, kh-crw, kh-rai-p, kh-st, kebab, gear, state-channels | .kh-roster-in 123px | `test-results/parity/1440-dark-pop-add-agent.diff.png` |
| 1440 | dark | empty-channel | 0.0112 | pass | gear, state-channels | — | `test-results/parity/1440-dark-empty-channel.diff.png` |
| 1440 | dark | failed-send | 0.0778 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-dark-failed-send.diff.png` |
| 1440 | dark | draft | 0.0631 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-dark-draft.diff.png` |
| 1100 | dark | thread | 0.1345 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1100-dark-thread.diff.png` |
| 900 | dark | thread | 0.1749 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/900-dark-thread.diff.png` |
| 900 | dark | list | 0.0190 | pass | state-channels | — | `test-results/parity/900-dark-list.diff.png` |
| 760 | dark | thread | 0.0967 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/760-dark-thread.diff.png` |
| 760 | dark | list | 0.0201 | blocked | state-channels | — | `test-results/parity/760-dark-list.diff.png` |
| 390 | dark | thread | 0.1059 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/390-dark-thread.diff.png` |
| 390 | dark | list | 0.0855 | blocked | state-channels | — | `test-results/parity/390-dark-list.diff.png` |
| 390 | dark | roster | 0.0721 | blocked | kh-ask, kh-badge, roster-requests, kh-crw, kh-st, kebab, gear | .kh-thread 48px, .kh-roster-in 123px | `test-results/parity/390-dark-roster.diff.png` |
| 390 | dark | chips | 0.0692 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/390-dark-chips.diff.png` |
| 390 | dark | detail-agent | 0.0347 | blocked | kh-ask, kh-badge, gear, detail-aiur | .kh-thread 48px | `test-results/parity/390-dark-detail-agent.diff.png` |
| 390 | dark | pop-invite | 0.1287 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/390-dark-pop-invite.diff.png` |
| 1440 | light | thread | 0.0811 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-light-thread.diff.png` |
| 1440 | light | roster | 0.0261 | blocked | kh-ask, kh-badge, roster-requests, kh-crw, kh-rai-p, kh-st, kebab, gear, state-channels | .kh-roster-in 123px | `test-results/parity/1440-light-roster.diff.png` |
| 1440 | light | chips | 0.0688 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-light-chips.diff.png` |
| 1440 | light | detail-agent | 0.1336 | blocked | kh-ask, kh-badge, gear, state-channels, detail-aiur | — | `test-results/parity/1440-light-detail-agent.diff.png` |
| 1440 | light | detail-human | 0.1432 | blocked | kh-ask, kh-badge, gear, state-channels, kh-d-agent-pct | — | `test-results/parity/1440-light-detail-human.diff.png` |
| 1440 | light | pop-new | 0.0820 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-light-pop-new.diff.png` |
| 1440 | light | pop-invite | 0.0981 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-light-pop-invite.diff.png` |
| 1440 | light | pop-add-agent | 0.0343 | blocked | kh-ask, kh-badge, roster-requests, kh-crw, kh-rai-p, kh-st, kebab, gear, state-channels | .kh-roster-in 123px | `test-results/parity/1440-light-pop-add-agent.diff.png` |
| 1440 | light | empty-channel | 0.0149 | pass | gear, state-channels | — | `test-results/parity/1440-light-empty-channel.diff.png` |
| 1440 | light | failed-send | 0.0811 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-light-failed-send.diff.png` |
| 1440 | light | draft | 0.0654 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1440-light-draft.diff.png` |
| 1100 | light | thread | 0.1376 | blocked | kh-ask, kh-badge, gear, state-channels | — | `test-results/parity/1100-light-thread.diff.png` |
| 900 | light | thread | 0.1837 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/900-light-thread.diff.png` |
| 900 | light | list | 0.0193 | pass | state-channels | — | `test-results/parity/900-light-list.diff.png` |
| 760 | light | thread | 0.0998 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/760-light-thread.diff.png` |
| 760 | light | list | 0.0205 | blocked | state-channels | — | `test-results/parity/760-light-list.diff.png` |
| 390 | light | thread | 0.1143 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/390-light-thread.diff.png` |
| 390 | light | list | 0.0862 | blocked | state-channels | — | `test-results/parity/390-light-list.diff.png` |
| 390 | light | roster | 0.0731 | blocked | kh-ask, kh-badge, roster-requests, kh-crw, kh-st, kebab, gear | .kh-thread 48px, .kh-roster-in 123px | `test-results/parity/390-light-roster.diff.png` |
| 390 | light | chips | 0.0759 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/390-light-chips.diff.png` |
| 390 | light | detail-agent | 0.0540 | blocked | kh-ask, kh-badge, gear, detail-aiur | .kh-thread 48px | `test-results/parity/390-light-detail-agent.diff.png` |
| 390 | light | pop-invite | 0.1708 | blocked | kh-ask, kh-badge, gear | .kh-thread 48px | `test-results/parity/390-light-pop-invite.diff.png` |


Screens marked **blocked** run as `todo`, each carrying its owner in `KNOWN_BLOCKED`. Diff images and fixture screenshots are under `apps/web/test-results/parity/` (gitignored, rewritten each run). The causes:

- **Every blocked screen:** Executor decision `dec_f83838efca089ad3`. M1 omits the #id badges, so names, mentions and previews are shorter, lines rewrap, and agent rows are 1px shorter. The gate itself is open as decision `dec_4e1280cb3a29b228` (open item 1).
- **1440 and 1100 screens with the list column:** the design lists the unsent message as Release's preview (open item 8).
- **`roster`, `pop-add-agent`:** KM-183's §22 Live roster copy (`Owner of N agents`, the harness).
- **`detail-agent`:** KM-183's §22 Live detail, meaning the harness line, the Harness/Owner table and a full-width @ Mention.
- **`detail-human`:** the KM-183 defect in open item 4, plus the §22 copy.
- **Only 4 screens pass:** 1440 empty-channel and 900 list, in both themes. 760 list is just over the threshold, at 0.0201 dark and 0.0205 light.

### Computed styles

| Viewport | Selectors compared | Exact properties | Boxes compared | Mismatches |
|---|---|---|---|---|
| 1440-dark | 47 | 10 | 18 | `.kh-ev i`: background-color: rgb(47, 134, 255) ≠ rgb(63, 185, 80) |
| 1440-light | 47 | 10 | 18 | `.kh-ev i`: background-color: rgb(31, 87, 196) ≠ rgb(31, 157, 77) |
| 390-dark | 47 | 10 | 18 | `.kh-ev i`: background-color: rgb(47, 134, 255) ≠ rgb(63, 185, 80) |

Computed-style notes:

- **Exact properties.** `color`, `background-color`, `font-size`, `font-weight`, `font-family`, `padding`, `border-radius`, `border`, `line-height` and `letter-spacing`, for every selector in `reference/computed-styles.json`.
- **Skipped:** `.kh-id`, at all three viewports. Under Executor decision `dec_f83838efca089ad3`, M1 renders it only for colliding names, and the fixture has none.
- **Alias:** KM-172's channel-event pill is the §8 `.kh-ev`, so the spec compares `.kh-ev` with `.channel-event-pill__link` and `.kh-ev i` with `.channel-event-pill__dot`.
- **Boxes (±2px)** are compared for the 18 layout selectors: card, list, list head, search, rows, avatars, header, stack, thread, chips bar, composer, input, send, wordmark and back.
- **Boxes skipped:** those that follow dataset text or thread scroll, namely names, tags, mentions, bubbles, the event pill, the receipt, chips, the day separator and the first avatar. Also `.kh-hacts .kh-ib` (open item 3).
- **Tokens (§25.2):** every `:root` token the design defines equals the product's `.khala-app` value, in 1440 dark and light and 390 dark. Numbers are compared by value, so `.2` equals `0.20`.
- **Landing font stack (§19):** the Sign in link's stack is `"JetBrains Mono", "Aiur JetBrains Mono", monospace` rather than the verbatim `"JetBrains Mono", monospace`. The landing page doesn't load Google Fonts, so KM-187 keeps the self-hosted face as a fallback. The check requires the stack to start with `"JetBrains Mono"`.
- **Font walk:** every rendered element under `.khala-app` is checked on each page. The four app pages are harness builds, so the verbatim Google Fonts `<link>` is checked in `apps/web/index.html`; every fixture page carries it too.

### Fonts

| Page | Elements checked | Off-stack elements | Bungee outside the wordmark | Wordmark | Google Fonts link | Result |
|---|---|---|---|---|---|---|
| fixture 1440-dark-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-roster | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-chips | 457 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-detail-agent | 461 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-detail-human | 471 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-pop-new | 436 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-pop-invite | 456 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-pop-add-agent | 439 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-empty-channel | 148 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-failed-send | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-dark-draft | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1100-dark-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 900-dark-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 900-dark-list | 424 | 0 | 0 | Bungee | yes | pass |
| fixture 760-dark-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 760-dark-list | 424 | 0 | 0 | Bungee | yes | pass |
| fixture 390-dark-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 390-dark-list | 424 | 0 | 0 | Bungee | yes | pass |
| fixture 390-dark-roster | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 390-dark-chips | 457 | 0 | 0 | Bungee | yes | pass |
| fixture 390-dark-detail-agent | 461 | 0 | 0 | Bungee | yes | pass |
| fixture 390-dark-pop-invite | 456 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-roster | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-chips | 457 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-detail-agent | 461 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-detail-human | 471 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-pop-new | 436 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-pop-invite | 456 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-pop-add-agent | 439 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-empty-channel | 148 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-failed-send | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1440-light-draft | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 1100-light-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 900-light-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 900-light-list | 424 | 0 | 0 | Bungee | yes | pass |
| fixture 760-light-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 760-light-list | 424 | 0 | 0 | Bungee | yes | pass |
| fixture 390-light-thread | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 390-light-list | 424 | 0 | 0 | Bungee | yes | pass |
| fixture 390-light-roster | 433 | 0 | 0 | Bungee | yes | pass |
| fixture 390-light-chips | 457 | 0 | 0 | Bungee | yes | pass |
| fixture 390-light-detail-agent | 461 | 0 | 0 | Bungee | yes | pass |
| fixture 390-light-pop-invite | 456 | 0 | 0 | Bungee | yes | pass |
| app /channels/room_1 | 93 | 0 | 0 | Bungee | n/a (harness; index.html checked) | pass |
| app /conversations | 50 | 0 | 0 | Bungee | n/a (harness; index.html checked) | pass |
| sign-in redirect | 22 | 0 | 0 | Bungee | n/a (harness; index.html checked) | pass |
| agent confirm | 57 | 0 | 0 | Bungee | n/a (harness; index.html checked) | pass |

### Behaviour and structure (§25.5–11)

| Check | Result | Evidence |
|---|---|---|
| `runs` | pass | Across the six channels, every run is `first`, `first`/`last-of` or `first`/`mid`…/`last-of`. The name line is on the first row only, with ghosts on all but the last. The design dataset has no three-message run, so `first`/`mid`/`last-of` is covered by `features/timeline/runs.test.ts` ("marks three in a row first, mid and last-of"). |
| `ownership` | pass | The viewer's rows are `.me` with no avatar. The viewer's agents (Opus, Sonnet) are left rows tagged `Your machine`, uppercased by CSS to YOUR MACHINE. Maya Chen and Kai Watanabe are `.human`. |
| `receipt` | pass | Each of the six channels shows exactly one receipt, straight after the viewer's last message. Release shows `Not sent` with one `.kh-retry`; the others show `Delivered`. None says "Read". |
| `chips` | pass | Flat order: `@Opus YO`, `@Sonnet YO`, `MC @Maya`, then `+5`. The grid is You → your agents → Maya → her agents → Kai → his agents. CI flake (one chip) has no toggle. Docs site launch (the viewer has no agents) has no viewer row. |
| `D1` | pass | Dark human chips compute to `hsl(oh 70% 72%)`, and light ones to `hsl(oh 60% 36%)`, for every `--oh`. |
| `D2` | pass | At 390 px, a closed `.kh-detail` is `visibility: hidden` and not visible. |
| `D3` | pass | `.kh-d-owner b` and `.kh-d-owner > span` are 12.48px (.78rem) in another owner's agent detail. |
| `D5` | pass | Every `.kh-d-agent > .kh-av` in a human's detail is 32×32. |
| `m1-matrix` | pass | The §22 "Omit" elements are absent from the thread, roster, both details, the invite and New channel popovers, and chips: `.kh-ask`, `.kh-badge`, `.kh-req`, `.kh-crw`, `.kh-rai-p`, `.kh-d-bar`, the Aiur kv rows, `#kh-d-open`, `.kh-keb`, `.kh-confirm`, `.kh-react`, the typing indicator, the settings gear, `.kh-list-foot`, `.dead` rows, `.kh-fin`, `.kh-st`, `.kh-d-agent > i` and Read receipts. The invite Type, Approve joins and History controls are `disabled` with `title="Coming soon"`, as are the listening-mode segments. |
| `sign-in` (landing) | pass | No "Open Khala app". The top-right `Sign in` link points to `/api/human/auth/login?return_to=%2Fconversations` and uses JetBrains Mono at 12.16px (.76rem), with a 999px radius and a 1px solid border. |
| `sign-in` (signed out) | pass | A signed-out `/conversations` requests the login URL once, with `return_to=/conversations`. It shows only the `Signing in…` card, with no heading and no Sign in button. |
| `main` landmark | pass | `shell.browser.spec.ts` now asserts exactly one `main` landmark (`<main class="kh-main">`), per the Executor note. |

### Accessibility (§25.12)

**Not run.** `axe-core` is not among the repository's dependencies, and the ticket says not to add one without asking. Adding it, plus a `§25.12` test at 1440 and 390 in both themes, is a follow-up if the Executor wants it.

## Fixes applied

There was no CSS drift to fix in the design-lane files. Every computed style and token the design defines matches exactly, apart from the event dot (open item 2). The fixes below come from the Executor notes on #872. Each is listed with its ticket of origin.

| Change | Where | Ticket of origin |
|---|---|---|
| Owner badges use the owner's full-name initials (`KW`, `MC`), from one shared helper (`ownerInitials`) in the thread, list and chips. The roster already used full names. | `ui/khala/identity.ts`, `features/timeline/TimelineScreen.tsx`, `ui/conversation/ConversationList.tsx` | KM-182 / KM-181 |
| List agent avatars show the harness logo. The product learns each agent member's harness and owner from the participant directory, keyed by Matrix user id (`participants.describeUser`), once a room has resolved them. | `ui/conversation/ConversationList.tsx`, `composition/human/{browser-api,application,mount}.ts(x)`, `main.tsx` | KM-181 |
| The viewer's own agents in the list carry `YO` on the viewer hue, as in the thread and roster. | `ui/conversation/ConversationList.tsx` | KM-181 |
| List times are always `h:mm` (§4.1); older rows no longer say `Yesterday` or `Monday`. The `now` prop is gone. | `ui/conversation/ConversationList.tsx` | KM-181 |
| Chips follow channel member order (Maya before Kai). `TimelineScreen` takes `members` in member order, which also names members who have not spoken. | `features/timeline/TimelineScreen.tsx`, `composition/human/room.tsx` | KM-184 |
| The thread pane is the page's one `main` landmark. | `ui/khala/KhalaApp.tsx` | KM-180 |
| `Brand` is exported and reused by the confirm page instead of a duplicated brand row. | `ui/khala/KhalaApp.tsx`, `features/agent-confirm/AgentConfirm.tsx` | KM-185 |
| A toggled theme is remembered (`persistTheme`), in the app and on the confirm page. Before this, nothing called `persistTheme`. | `composition/human/screen.tsx`, `features/agent-confirm/AgentConfirm.tsx` | KM-180 / KM-185 |
| Removed the duplicate `.kh-hint` (`controls.css:52` keeps it) and the dead `.showcase-app .conversation-composer` rule. `features/channel/channel.css` had no `.conversation-composer` left. | `ui/khala/list.css`, `landing/showcase.css` | KM-181 / KM-182 |
| In the fixture, the `?empty=1` unread count matches the design's `3 unread`: Release stays read. | `ui/conversation/fixture.tsx` | KM-188 |
| Full-bleed references no longer reserve a scrollbar gutter (see above). | `docs/design/khala-chat/reference/fullbleed-inject.css` | KM-186 (reference lane) |

These are test-only edits under the Executor's standing rule. The agent-confirm browser harness takes `?path=` (to test a signed-out `/conversations`) and loads the product entry's stylesheets. The shell harness drops its pinned `now`. The shell visual baselines were regenerated in `mcr.microsoft.com/playwright:v1.63.0-noble`, because the shell harness list now shows clock times.

## Open items

1. **Operator decision `dec_4e1280cb3a29b228`: the screen gate.** 40 of 44 screens exceed 0.02, almost entirely because M1 omits the #id badges (Executor decision `dec_f83838efca089ad3`). That makes agent names, mentions and list previews shorter, which changes line wraps, and each agent row is 1px shorter. The options:
   - **A:** keep the pure-design references, with these screens as `todo` and their ratios reported here. This is the recommendation and the default.
   - **B:** hide `.kh-id` in `fullbleed-inject.css` and re-capture, so the references show M1 naming. Then gate the screens at 0.02.
   - **C:** raise the threshold.

   The threshold stays at 0.02 until the Executor decides.
2. **Operator decision: the event pill dot.** KM-172's channel-event pill colours its dot by status: a pending review is `--accent`. The design's `.kh-ev i` is always `--good` (§8). `computed: *: .kh-ev i` is `todo` until the Executor picks one.
3. **Operator decision: the empty gear slot.** With the §22-omitted settings gear gone, the Invite button sits in the gear's place at the right edge of `.kh-hacts`, rather than one slot to its left. I didn't add a placeholder (no invented UI). `.kh-hacts .kh-ib`'s box is excluded from the computed check for this reason.
4. **Blocking, KM-183:** "Recent in Khala" in the detail pane shows mentions as plain text (`@Sonnet`), while the design renders `.kh-mention` links. This is a DOM change, so it isn't fixed here.
5. **Blocking, KM-182 (with KM-172):** the event pill puts its ` · ` separator in its own flex item. The pill's `.45rem` gap then pads both sides (`feat/events-cursor  ·  10:09`), where the design has a tight ` · 10:09`. This is markup in `ChannelEventPill.tsx`.
6. **Blocking, KM-185 / KM-180:** in the product, `/agent/confirm` renders inside the owner shell. The confirm page's own `.khala-app` (with its brand row) sits in the shell's `main`, next to the conversation list. §20 asks for a full-viewport page with the brand row top-left and no list.
7. **Note, §22 roster modes:** the viewer's agents render the disabled listening-mode segment and a disabled `.kh-mode-btn`, the narrow-width trigger for the mode menu. §22 says to omit the menu; the trigger never opens it. Confirm whether the disabled button should stay.
8. **Note, data rather than drift:**
   - The design lists the unsent message as Release's preview and time (`You: @Codex #620 ping here…`, 10:12). The product lists sent messages only (`Sonnet: Pushing both fixes now…`, 10:11).
   - The design's empty-channel capture shows a `Created` toast. The fixture builds the empty channel directly, so it doesn't.
   - Roster and detail copy follow §22 "Live" (`Owner of N agents`, the harness name, `Your agent`). The design shows role · host, task titles and model lines there.
9. **Note:** list harness logos appear in the product once a room's participants have resolved. Before that, the list falls back to initials, because the conversation index has no harness data of its own.

## D1 (restated from §21)

The design's `.kh-chip-h { color: hsl(var(--oh) 60% 36%) }` (`source:604`) lost its light-theme scope, so dark human chips come out about 2.3:1. That fails WCAG AA. The accepted fix scopes that colour to light. In dark, human chips are `hsl(oh 70% 72%)`, about 8:1 on the chip. `reference/fullbleed-inject.css` applies the same fix to the design, and the `D1` checks above confirm the product follows it in both themes. **The operator's sign-off on D1 and on this report is pending.**
