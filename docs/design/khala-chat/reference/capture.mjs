// Re-captures the Khala reference from the REAL design (source/Aiur Dashboard.html, full JS).
//   PLAYWRIGHT_CORE_PKG=<path to playwright-core/package.json> node docs/design/khala-chat/reference/capture.mjs
// Outputs: reference/screens/*.png (+ index.json) and reference/computed-styles.json.
// "design-*" shots = the design exactly as authored (embedded in the dashboard).
// "fullbleed-*" shots = same page + fullbleed-inject.css + brand row (the edge-to-edge target, D1–D5 fixed).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
const require = createRequire(process.env.PLAYWRIGHT_CORE_PKG ?? import.meta.url);
const { chromium } = require('playwright-core');
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const OUT = ROOT + '/reference/screens';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const URL_ = 'file://' + encodeURI(ROOT + '/source/Aiur Dashboard.html');
const INJECT = readFileSync(ROOT + '/reference/fullbleed-inject.css', 'utf8');
const SUN = '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const BRAND = '<div class="kh-brand"><img class="brand-logo" src="assets/aiur-logo.png" alt=""><a class="wm" href="#">khala</a><span class="status-badge status-badge-live brand-live"><span class="status-badge-dot"></span> Live</span><span class="kh-brand-actions"><button class="tool-btn icon-only" type="button" aria-label="Toggle color theme"><span class="toggle-icon">' + SUN + '</span></button></span></div>';

const browser = await chromium.launch();
const shots = [];
async function open(width, height, theme, fullbleed) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto(URL_ + '?theme=' + theme, { waitUntil: 'networkidle' });
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await page.click('.snav[data-tab="khala"]');
  if (fullbleed) {
    await page.addStyleTag({ content: INJECT });
    await page.evaluate((b) => { document.querySelector('#kh-card .kh-list').insertAdjacentHTML('afterbegin', b); }, BRAND);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
async function shot(name, width, height, theme, fullbleed, act) {
  const { ctx, page, errors } = await open(width, height, theme, fullbleed);
  if (act) await act(page);
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push({ name, width, height, theme, fullbleed, errors });
  await ctx.close();
}
const clickJS = (sel) => async (page) => { await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel); };
const toThread = clickJS('#kh-convos .kh-cv');            // first conversation, sets .in-thread (matters <=900)
const STATES = {
  roster: clickJS('#kh-head-btn'),
  chips: clickJS('#kh-to-tog'),
  'detail-agent': clickJS('#kh-thread .kh-row:not(.human):not(.me) .kh-av:not(.ghost)'),
  'detail-human': clickJS('#kh-thread .kh-row.human .kh-av:not(.ghost)'),
  'pop-new': clickJS('[data-kh-act="new"]'),
  'pop-invite': clickJS('[data-kh-act="share"]'),
  'pop-settings': clickJS('[data-kh-act="settings"]'),
  'pop-add-agent': async (p) => { await clickJS('#kh-head-btn')(p); await p.waitForTimeout(300); await clickJS('[data-kh-act="add-agent"]')(p); },
  'pop-mode-menu': async (p) => { await clickJS('#kh-head-btn')(p); await p.waitForTimeout(300); await clickJS('[data-kh-act="keb"][data-kind="keb-agent"]')(p); },
  'state-pending': clickJS('[data-kh-convo="infra"]'),
  'state-deleted': clickJS('[data-kh-convo="old-launch"]'),
  'state-used': clickJS('[data-kh-act="pv-used"]'),
  'agent-finish': clickJS('[data-kh-act="pv-finish"]'),
  'failed-send': async (p) => { await p.evaluate(() => { const t = document.querySelector('#kh-thread'); t.scrollTop = t.scrollHeight; }); },
  'typing': async (p) => { await p.fill('#kh-input', '@395 status?'); await p.press('#kh-input', 'Enter'); await p.waitForTimeout(1200); },
  'empty-channel': async (p) => { await clickJS('[data-kh-act="new"]')(p); await p.waitForTimeout(200); await p.fill('#kh-new-name', 'Launch'); await clickJS('[data-kh-act="create"]')(p); },
  'draft': async (p) => { await p.fill('#kh-input', 'Line one\nLine two\nLine three'); await p.dispatchEvent('#kh-input', 'input'); },
};
for (const theme of ['dark', 'light']) {
  await shot(`design-1440-${theme}-embedded`, 1440, 900, theme, false);
  await shot(`design-1440-${theme}-embedded-roster`, 1440, 900, theme, false, STATES.roster);
  for (const [w, h] of [[1440, 900], [1100, 800], [900, 800], [760, 900], [390, 844]]) {
    await shot(`fullbleed-${w}-${theme}-thread`, w, h, theme, true, toThread);
    if (w <= 900) await shot(`fullbleed-${w}-${theme}-list`, w, h, theme, true);
  }
  for (const [state, act] of Object.entries(STATES)) {
    await shot(`fullbleed-1440-${theme}-${state}`, 1440, 900, theme, true, act);
  }
  for (const state of ['roster', 'chips', 'detail-agent', 'pop-invite', 'state-pending', 'agent-finish']) {
    await shot(`fullbleed-390-${theme}-${state}`, 390, 844, theme, true, async (p) => { await toThread(p); await p.waitForTimeout(200); await STATES[state](p); });
  }
}
// Computed-style extract from the real design (full-bleed) at 1440 dark/light and 390 dark.
const SEL = ['.kh-card', '.kh-list', '.kh-list-head b', '.kh-list-head span', '.kh-ib', '.kh-search', '.kh-search input', '.kh-cv', '.kh-cv.is-active', '.kh-cv-t b', '.kh-cv-t time', '.kh-cv-pv', '.kh-cv-av .kh-av', '.kh-head', '.kh-stack .kh-av', '.kh-head-t > b', '.kh-head-t > span', '.kh-head-t .on', '.kh-hacts .kh-ib', '.kh-thread', '.kh-day', '.kh-row:not(.me):not(.human) .kh-b', '.kh-row.human .kh-b', '.kh-row.me .kh-b', '.kh-row.failed .kh-b', '.kh-name', '.kh-name b', '.kh-id', '.kh-otag', '.kh-htag', '.kh-mention', '.kh-mention.kh-hm', '.kh-b code', '.kh-av', '.kh-own', '.kh-ev', '.kh-ev i', '.kh-rcpt', '.kh-retry', '.kh-to', '.kh-chip-a', '.kh-chip-h', '.kh-to-tog', '.kh-comp', '.kh-input', '.kh-send', '.kh-brand .wm', '.kh-back'];
const PROPS = ['display', 'width', 'height', 'padding', 'margin', 'gap', 'grid-template-columns', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'color', 'background-color', 'border', 'border-radius', 'box-shadow', 'opacity'];
const computed = {};
for (const [w, h, theme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [390, 844, 'dark']]) {
  const { ctx, page } = await open(w, h, theme, true);
  await toThread(page);
  await page.waitForTimeout(300);
  computed[`${w}-${theme}`] = await page.evaluate(({ SEL, PROPS }) => {
    const out = {};
    for (const s of SEL) {
      const el = document.querySelector('#kh-card ' + s) || document.querySelector(s);
      if (!el) { out[s] = null; continue; }
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      out[s] = { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], ...Object.fromEntries(PROPS.map((p) => [p, cs.getPropertyValue(p)])) };
    }
    out[':root tokens'] = Object.fromEntries(['--bg', '--bg-2', '--surface', '--surface-2', '--surface-3', '--fg', '--muted', '--faint', '--line', '--line-strong', '--hairline', '--pill-bd', '--pill-bg', '--accent', '--accent-ink', '--accent-soft', '--accent-line', '--attn', '--block', '--block-soft', '--block-line', '--good', '--good-ink', '--good-soft', '--shadow-sm', '--shadow-lg', '--radius', '--radius-lg'].map((v) => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()]));
    return out;
  }, { SEL, PROPS });
  await ctx.close();
}
writeFileSync(ROOT + '/reference/computed-styles.json', JSON.stringify(computed, null, 1));
writeFileSync(OUT + '/index.json', JSON.stringify(shots, null, 1));
const bad = shots.filter((s) => s.errors.length);
console.log(shots.length, 'shots;', bad.length, 'with page errors', bad.slice(0, 5).map((s) => s.name + ': ' + s.errors[0]).join('\n'));
await browser.close();
