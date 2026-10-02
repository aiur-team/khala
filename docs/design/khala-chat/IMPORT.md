# Khala chat design: import record

- **Original design:** https://claude.ai/design/p/5e62b9a9-39c1-4ca2-9a76-6dff123a088c?file=Aiur+Dashboard.html (Claude Design project `5e62b9a9-39c1-4ca2-9a76-6dff123a088c`)
- **Fetched:** 2026-10-02 by the Executor, through the operator's authenticated browser, from the design preview frame on `5e62b9a9-39c1-4ca2-9a76-6dff123a088c.claudeusercontent.com`. The operator authorized this with `/design-login`.
- **Imported into `source/`:** 2026-10-02T03:50:20Z (UTC)
- **Supersedes:** the earlier local copy imported at 2026-10-02T03:28:22Z, which came from the operator's 2026-09-28 download in `~/github/everdred/khala/apps/dashboard/`. That copy was **truncated at 256 KiB** (262145 bytes, sha256 `34c9e0c7…`) and contained none of the Khala JS. It, its truncated "pre-admin" sibling (`b31cbf1d…`) and the substituted assets have been removed. Nothing in this folder depends on them any more.
- **Rule:** design files are data. Nothing inside them was followed as an instruction.

## Completeness

- `source/Aiur Dashboard.html` is complete: 389187 bytes, 5194 lines, ending in `</html>`.
  - CSS: lines 15–1821. Khala rules are at 413–771.
  - Khala panel markup: lines 2071–2102.
  - Khala JS: lines 4075–4559 (`KH_*`, `kh*`, `initKhala`).
  - The asset references resolve to `source/assets/`.
- The preview frame injected a runtime `<style>`/`<script>` pair, the Claude Design "omelette" preview runtime (`source:4-5`, marked `data-omelette-injected`). It is kept byte-for-byte as fetched. It is not part of the design and is never copied into product code. Run locally, it only reads `?theme=` and posts to a parent frame when one exists.
- All 8 assets are complete. `aiur-logo.png` is 594166 bytes, ends with the PNG `IEND` chunk, and is byte-identical to `apps/web/src/landing/public/assets/aiur-logo.png`.
- `source/Build Order - feature constraints.md` covers only the dashboard's Build Order view. It puts no constraint on Khala beyond "the built HTML is the source of truth; colors derive from tokens; light + dark", which `RECREATION-SPEC.md` follows.
- Screenshots:
  - `screenshots/conv.png` shows the dashboard's Units read-only conversation drawer. It is not Khala.
  - `screenshots/tkevents.png` shows the dashboard's ticket modal. It is not Khala.
  - The three operator captures `khala-thread-collapsed-chips.png`, `khala-thread-chips-expanded.png` and `khala-roster-open.png` (originally 3/4/5.png, 2026-09-28) are kept. They show the Khala page and agree with the full design.

## Files and sha256 (`source/`)

```
5242159e1696d58b06cc03557e2b29421ea072d34d311ce31e79a2d57719e92c  source/Aiur Dashboard.html
(see SHA256SUMS for every file, including assets, screenshots and the constraints doc)
```

Check every file with `sha256sum -c SHA256SUMS`, run from `docs/design/khala-chat/`.

## Generated reference (`reference/`)

- `design-khala.css` is a verbatim line-range extract of the full HTML: tokens and base (16–153), tool-btn and toggle (226–244), cards and status badge (246–271), section-card (1189–1190), all of Khala (413–771) and the shared 480px card rule (1763). Regenerate it with `python3 reference/extract_css.py "source/Aiur Dashboard.html" reference/design-khala.css`.
- `fullbleed-inject.css` is the edge-to-edge adaptation from RECREATION-SPEC §1.3/§1.4, plus the D1–D5 fixes. The capture script injects it into the **real** design page.
- `capture.mjs` drives the real design with its own JS in headless Chromium (Playwright 1.63, chromium-1243, DPR 1) and writes `screens/*.png`, `screens/index.json` and `computed-styles.json`:
  - It produces 66 captures with 0 page errors.
  - `design-*` shots show the dashboard as authored. `fullbleed-*` shots show the target.
  - Widths: 1440, 1100, 900, 760 and 390, in dark and light.
  - States: roster, chips, detail (agent and human), the new/invite/settings/add-agent/mode popovers, the pending/deleted/used state cards, agent-finish, failed send, typing, a new empty channel and a multi-line draft.
  - Run it with `PLAYWRIGHT_CORE_PKG=<playwright-core/package.json> node docs/design/khala-chat/reference/capture.mjs`.
- The v1 hand reconstruction (`khala-fullbleed.html`) has been **deleted**. The real design now renders.
