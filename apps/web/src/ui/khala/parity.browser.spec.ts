// The design-parity audit (KM-186, RECREATION-SPEC §25): the KM-188 fixture
// against the real Claude Design references in docs/design/khala-chat/reference.
//
// - `screens:` pixel-compares the fixture with `reference/screens/fullbleed-*.png`
//   after painting the §22 masks (parity-masks.ts) on both images. The
//   references are only comparable on the machine and browser that captured
//   them (`reference/capture.mjs`, Playwright's bundled Chromium), so these
//   tests skip under CI; a CI gate is a follow-up.
// - `computed:`/`tokens:` compare computed styles with `reference/computed-styles.json`.
// - `fonts:` enforces the operator font directive (§2.1, §25.1).
// - The rest are the behaviour and structure checks of §25.5–11.
//
// Every run writes diff images and `results.json` to apps/web/test-results/parity,
// the input to docs/design/khala-chat/PARITY-REPORT.md. A known
// deviation ratchets at its measured value (SCREEN_MEASURED,
// COMPUTED_DEVIATIONS) until its owner fixes it, so new drift still fails.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type InlineConfig, type PreviewServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PARITY_MASKS } from './parity-masks';

const WEB = join(import.meta.dirname, '../../..');
const DESIGN = join(WEB, '../../docs/design/khala-chat');
const SCREENS = join(DESIGN, 'reference/screens');
const OUT = join(WEB, 'test-results/parity');
/** §25.4: the share of differing pixels a screen may have. Raising it is an Executor decision. */
const THRESHOLD = 0.02;
/** A pixel differs when any channel moves by more than this. */
const CHANNEL_DELTA = 16;
const SCREENS_SKIP = process.env.CI ? 'the references only match the capture machine’s rasteriser; the CI gate is a follow-up' : false;

type Theme = 'dark' | 'light';
type State = 'thread' | 'list' | 'roster' | 'chips' | 'detail-agent' | 'detail-human' | 'pop-new' | 'pop-invite' | 'pop-add-agent'
  | 'empty-channel' | 'failed-send' | 'draft';
type ScreenCase = Readonly<{ width: number; theme: Theme; state: State }>;
type Box = readonly [x: number, y: number, width: number, height: number];

const HEIGHTS: Readonly<Record<number, number>> = { 1440: 900, 1100: 800, 900: 800, 760: 900, 390: 844 };
const STATES_1440: readonly State[] = ['thread', 'roster', 'chips', 'detail-agent', 'detail-human', 'pop-new', 'pop-invite',
  'pop-add-agent', 'empty-channel', 'failed-send', 'draft'];
const SCREEN_CASES: readonly ScreenCase[] = (['dark', 'light'] as const).flatMap(theme => [
  ...STATES_1440.map(state => ({ width: 1440, theme, state })),
  { width: 1100, theme, state: 'thread' as const },
  ...[900, 760].flatMap(width => (['thread', 'list'] as const).map(state => ({ width, theme, state }))),
  ...(['thread', 'list', 'roster', 'chips', 'detail-agent', 'pop-invite'] as const).map(state => ({ width: 390, theme, state })),
]);
const screenName = (c: ScreenCase) => `${c.width}-${c.theme}-${c.state}`;

/**
 * The fixture's query per state. The design's Release thread ends with the
 * viewer's failed send, so every thread state uses `failed=1`.
 */
const FIXTURE_QUERY: Readonly<Record<State, string>> = {
  thread: 'failed=1', list: 'view=list', roster: 'failed=1&roster=1', chips: 'failed=1&chips=1',
  'detail-agent': 'failed=1&detail=AIUR-395', 'detail-human': 'failed=1&detail=kai', 'pop-new': 'failed=1&pop=new',
  'pop-invite': 'failed=1&pop=invite', 'pop-add-agent': 'failed=1&pop=add-agent', 'empty-channel': 'empty=1',
  'failed-send': 'failed=1', draft: `failed=1&draft=${encodeURIComponent('Line one\nLine two\nLine three')}`,
};
/** What each state waits for in the fixture before the screenshot. */
const FIXTURE_READY: Readonly<Partial<Record<State, string>>> = {
  roster: '.kh-roster.is-open', chips: '.kh-to.is-open', 'detail-agent': '.kh-detail .kh-d-in', 'detail-human': '.kh-detail .kh-d-in',
  'pop-new': '.kh-pop:not([hidden])', 'pop-invite': '.kh-pop:not([hidden])', 'pop-add-agent': '.kh-pop:not([hidden])',
};

/**
 * Known deviations, each with its owner: a ticket or an Executor decision.
 * They ratchet rather than skip, so new drift still fails; the owner tightens
 * or removes the entry with the fix or the decision. PARITY-REPORT.md lists
 * each one with its measured diff.
 */
const ID_BADGES = 'Executor decision dec_f83838efca089ad3: M1 omits the #id badges, so agent names, mentions and list previews are '
  + 'shorter and lines rewrap, and agent rows are 1px shorter without the badge in the name line';
const UNSENT_PREVIEW = 'the design lists the unsent message as Release’s preview; the product lists sent messages only';
const SCREEN_CAUSES: Readonly<Partial<Record<State, string>>> = {
  list: UNSENT_PREVIEW,
  roster: 'KM-183 (§22 Live): roster rows read “Owner of N agents” and the harness where the design shows role · host and the task',
  'pop-add-agent': 'KM-183 (§22 Live): roster rows read “Owner of N agents” and the harness where the design shows role · host and the task',
  'detail-agent': 'KM-183 (§22 Live): the hero names the harness and the pane shows the Harness/Owner table and a full-width @ Mention',
  'detail-human': 'KM-183: agent rows read label · owner and the harness',
};
const screenCause = (c: ScreenCase) => SCREEN_MEASURED[screenName(c)] === undefined ? null
  : [ID_BADGES, c.state === 'list' || c.width <= 900 ? null : `${UNSENT_PREVIEW} (list column)`, SCREEN_CAUSES[c.state]].filter(Boolean).join('; ');
/** Headroom over a measured ratio for capture timing: animated states move by about 1,100 px between captures. */
const SCREEN_SLACK = 0.005;
/**
 * The measured ratio of every screen over THRESHOLD on the capture machine,
 * while decision dec_4e1280cb3a29b228 is open. Its ceiling is this plus
 * SCREEN_SLACK and its cause is `screenCause`; an unlisted screen gates at THRESHOLD.
 */
const SCREEN_MEASURED: Readonly<Record<string, number>> = {
  '1440-dark-thread': 0.0775, '1440-dark-roster': 0.0238, '1440-dark-chips': 0.0665, '1440-dark-detail-agent': 0.1267,
  '1440-dark-detail-human': 0.1395, '1440-dark-pop-new': 0.0698, '1440-dark-pop-invite': 0.0794, '1440-dark-pop-add-agent': 0.0314,
  '1440-dark-failed-send': 0.0775, '1440-dark-draft': 0.0625, '1100-dark-thread': 0.1340, '900-dark-thread': 0.1747,
  '760-dark-thread': 0.0965, '760-dark-list': 0.0201, '390-dark-thread': 0.1055, '390-dark-list': 0.0855, '390-dark-roster': 0.0718,
  '390-dark-chips': 0.0689, '390-dark-detail-agent': 0.0347, '390-dark-pop-invite': 0.1079,
  '1440-light-thread': 0.0807, '1440-light-roster': 0.0260, '1440-light-chips': 0.0684, '1440-light-detail-agent': 0.1332,
  '1440-light-detail-human': 0.1428, '1440-light-pop-new': 0.0816, '1440-light-pop-invite': 0.0842, '1440-light-pop-add-agent': 0.0342,
  '1440-light-failed-send': 0.0807, '1440-light-draft': 0.0647, '1100-light-thread': 0.1371, '900-light-thread': 0.1835,
  '760-light-thread': 0.0996, '760-light-list': 0.0205, '390-light-thread': 0.1139, '390-light-list': 0.0862,
  '390-light-roster': 0.0727, '390-light-chips': 0.0756, '390-light-detail-agent': 0.0540, '390-light-pop-invite': 0.1196,
};
const screenCeiling = (c: ScreenCase) => {
  const measured = SCREEN_MEASURED[screenName(c)];
  return measured === undefined ? THRESHOLD : measured + SCREEN_SLACK;
};
/**
 * Computed values that knowingly differ from the design, by selector, viewport
 * and property. The test expects the current value instead, so any other
 * change still fails.
 */
const COMPUTED_DEVIATIONS: Readonly<Record<string, Readonly<{ reason: string; values: Readonly<Record<string, Readonly<Record<string, string>>>> }>>> = {};

// --- The design page, for mask boxes: the same page and steps as reference/capture.mjs. ---

const DESIGN_URL = 'file://' + encodeURI(join(DESIGN, 'source/Aiur Dashboard.html'));
const SUN = '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const BRAND = '<div class="kh-brand"><img class="brand-logo" src="assets/aiur-logo.png" alt=""><a class="wm" href="#">khala</a><span class="status-badge status-badge-live brand-live"><span class="status-badge-dot"></span> Live</span><span class="kh-brand-actions"><button class="tool-btn icon-only" type="button" aria-label="Toggle color theme"><span class="toggle-icon">' + SUN + '</span></button></span></div>';
const clickJS = (selector: string) => (page: Page) => page.evaluate(sel => { (document.querySelector(sel) as HTMLElement | null)?.click(); }, selector);
const toThread = clickJS('#kh-convos .kh-cv');
const DESIGN_ACTIONS: Readonly<Partial<Record<State, (page: Page) => Promise<void>>>> = {
  roster: clickJS('#kh-head-btn'),
  chips: clickJS('#kh-to-tog'),
  'detail-agent': clickJS('#kh-thread .kh-row:not(.human):not(.me) .kh-av:not(.ghost)'),
  'detail-human': clickJS('#kh-thread .kh-row.human .kh-av:not(.ghost)'),
  'pop-new': clickJS('[data-kh-act="new"]'),
  'pop-invite': clickJS('[data-kh-act="share"]'),
  'pop-add-agent': async page => { await clickJS('#kh-head-btn')(page); await page.waitForTimeout(300); await clickJS('[data-kh-act="add-agent"]')(page); },
  'failed-send': page => page.evaluate(() => { const thread = document.querySelector('#kh-thread')!; thread.scrollTop = thread.scrollHeight; }),
  'empty-channel': async page => {
    await clickJS('[data-kh-act="new"]')(page); await page.waitForTimeout(200);
    await page.fill('#kh-new-name', 'Launch'); await clickJS('[data-kh-act="create"]')(page);
  },
  draft: async page => { await page.fill('#kh-input', 'Line one\nLine two\nLine three'); await page.dispatchEvent('#kh-input', 'input'); },
};

type DesignLayout = Readonly<{
  masks: Readonly<Record<string, readonly Box[]>>;
  /** Space the fixture reserves for in-flow omitted elements (`ParityMask.reserve`), by fixture container. */
  reserves: readonly Reserve[];
}>;
type Reserve = Readonly<{ fixture: string; height: number }>;

/** Each mask's visible boxes in the design reference for one screen. */
async function designLayout(browser: Browser, c: ScreenCase, inject: string): Promise<DesignLayout> {
  const context = await newContext(browser, c.width, HEIGHTS[c.width]!, c.theme);
  try {
    const page = await context.newPage();
    await page.goto(`${DESIGN_URL}?theme=${c.theme}`, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, c.theme);
    await page.click('.snav[data-tab="khala"]');
    await page.addStyleTag({ content: inject });
    await page.evaluate(brand => { document.querySelector('#kh-card .kh-list')!.insertAdjacentHTML('afterbegin', brand); }, BRAND);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    if (c.width < 1440 && c.state !== 'list') await toThread(page);
    if (c.width === 390 && c.state !== 'thread' && c.state !== 'list') await page.waitForTimeout(200);
    await DESIGN_ACTIONS[c.state]?.(page);
    await page.waitForTimeout(450);
    const reserves = await page.evaluate(list => list.flatMap(({ selectors, design, fixture }) => {
      const container = document.querySelector<HTMLElement>(design);
      const element = container?.querySelector<HTMLElement>(selectors.join(', '));
      if (!container || !element || !element.checkVisibility() || container.clientHeight === 0 || container.scrollTop > 0) return [];
      const style = getComputedStyle(element);
      return [{ fixture, height: element.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom) }];
    }), PARITY_MASKS.flatMap(mask => mask.reserve ? [{ selectors: mask.selectors, ...mask.reserve }] : []));
    const masks = await page.evaluate(list => Object.fromEntries(list.map(mask => [mask.id,
      [...document.querySelectorAll<HTMLElement>(mask.selectors.join(', '))].flatMap(element => {
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return [];
        // Clip to every scrolling ancestor and the viewport, so a scrolled-out row masks nothing.
        let { left, top, right, bottom } = element.getBoundingClientRect();
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflow === 'visible') continue;
          const clip = parent.getBoundingClientRect();
          left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
        }
        left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
        return right > left && bottom > top
          ? [[Math.floor(left), Math.floor(top), Math.ceil(right - left), Math.ceil(bottom - top)] as const] : [];
      })])), PARITY_MASKS.map(mask => ({ id: mask.id, selectors: mask.selectors })));
    return { masks, reserves };
  } finally {
    await context.close();
  }
}

// --- Shared harness state. ---

let scratch = '';
let browser: Browser | null = null;
const servers: PreviewServer[] = [];
let fixtureUrl = '';
let comparePage: Page | null = null;
const results: Record<string, unknown>[] = [];

async function serve(config: InlineConfig, outDir: string): Promise<string> {
  await build({ ...config, build: { ...config.build, outDir, emptyOutDir: true }, logLevel: 'error' });
  const server = await preview({ ...config, build: { outDir }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  servers.push(server);
  return server.resolvedUrls!.local[0]!;
}

async function newContext(target: Browser, width: number, height: number, theme: Theme): Promise<BrowserContext> {
  const context = await target.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  // tsx keeps function names with a `__name` helper the page does not have.
  await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || (f => f);' });
  return context;
}

const memo = new Map<string, Promise<FixtureCapture>>();
type FixtureCapture = Readonly<{ shot: Buffer; fonts: FontWalk }>;
type FontWalk = Readonly<{ wrong: readonly string[]; bungee: readonly string[]; wordmarks: readonly string[]; googleLink: boolean; elements: number }>;

/** Walks every element: §25.1's family rule under `.khala-app`, and Bungee only on the wordmark anywhere. */
function walkFonts(): FontWalk {
  const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string'
    ? `.${element.className.trim().split(/\s+/u).join('.')}` : ''}`;
  const wrong: string[] = [];
  const bungee: string[] = [];
  const wordmarks: string[] = [];
  let elements = 0;
  for (const element of document.querySelectorAll('*')) {
    const family = getComputedStyle(element).fontFamily;
    const wordmark = element.matches('.kh-brand .wm');
    if (wordmark) wordmarks.push(family);
    else if (/^"?Bungee/u.test(family)) bungee.push(`${describe(element)}: ${family}`);
    if (!element.closest('.khala-app')) continue;
    elements += 1;
    if (wordmark ? !family.startsWith('Bungee') : !(family.startsWith('"Space Grotesk"') || family.startsWith('"JetBrains Mono"'))) {
      wrong.push(`${describe(element)}: ${family}`);
    }
  }
  const googleLink = document.querySelector('link[href^="https://fonts.googleapis.com/css2?family=Bungee&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"]') !== null;
  return { wrong: [...new Set(wrong)].slice(0, 12), bungee: bungee.slice(0, 12), wordmarks, googleLink, elements };
}

/**
 * At one-pane widths (≤900) the capture opened the channel by clicking it, which
 * shows the thread from the top; wider, the open thread keeps its latest-message scroll.
 */
const opensAtTop = (c: ScreenCase) => c.width <= 900 && c.state !== 'list';

async function openFixture(c: ScreenCase, query = FIXTURE_QUERY[c.state]): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newContext(browser!, c.width, HEIGHTS[c.width]!, c.theme);
  const page = await context.newPage();
  await page.goto(`${fixtureUrl}conversation-fixture.html?theme=${c.theme}&${query}`);
  await page.locator('#kh-card').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const ready = FIXTURE_READY[c.state];
  if (ready) await page.locator(ready).first().waitFor({ state: 'attached' });
  // The fixture drives its state and scroll a frame or two after the presence snapshot; transitions take .25s.
  await page.waitForTimeout(900);
  if (opensAtTop(c)) await page.evaluate(() => { document.querySelector('.kh-thread')!.scrollTop = 0; });
  return { context, page };
}

function captureFixture(c: ScreenCase, reserves: readonly Reserve[] = []): Promise<FixtureCapture> {
  const key = screenName(c);
  if (!memo.has(key)) {
    memo.set(key, (async () => {
      const { context, page } = await openFixture(c);
      try {
        const fonts = await page.evaluate(walkFonts);
        // Reserve the omitted elements' space (masked on both images), so what follows aligns.
        await page.evaluate(list => {
          for (const { fixture, height } of list) {
            const container = document.querySelector<HTMLElement>(fixture);
            if (!container) continue;
            // The spacer joins the container's flex gap, as the omitted element did.
            const spacer = document.createElement(container.matches('ul, ol') ? 'li' : 'div');
            spacer.setAttribute('aria-hidden', 'true');
            spacer.style.cssText = `flex: none; height: ${height}px; list-style: none;`;
            container.prepend(spacer);
            container.scrollTop = 0;
          }
        }, reserves);
        return { shot: await page.screenshot(), fonts };
      } finally {
        await context.close();
      }
    })());
  }
  return memo.get(key)!;
}

/** Paints `boxes` on both PNGs and counts pixels whose largest channel delta exceeds CHANNEL_DELTA. */
async function pixelDiff(actual: Buffer, expected: Buffer, boxes: readonly Box[]) {
  return comparePage!.evaluate(async ({ a, b, boxes: masks, delta }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
    });
    const [first, second] = await Promise.all([load(a), load(b)]);
    if (first.width !== second.width || first.height !== second.height) {
      return { diff: -1, total: 0, size: `${first.width}x${first.height} vs ${second.width}x${second.height}`, png: '' };
    }
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      context.fillStyle = '#ff00ff';
      for (const [x, y, w, h] of masks) context.fillRect(x, y, w, h);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const left = pixels(first);
    const right = pixels(second);
    const canvas = document.createElement('canvas');
    canvas.width = first.width; canvas.height = first.height;
    const context = canvas.getContext('2d')!;
    const out = context.createImageData(first.width, first.height);
    let diff = 0;
    for (let index = 0; index < left.length; index += 4) {
      const differs = Math.abs(left[index]! - right[index]!) > delta || Math.abs(left[index + 1]! - right[index + 1]!) > delta
        || Math.abs(left[index + 2]! - right[index + 2]!) > delta;
      if (differs) diff += 1;
      const grey = (left[index]! + left[index + 1]! + left[index + 2]!) / 9;
      out.data[index] = differs ? 255 : grey; out.data[index + 1] = differs ? 0 : grey; out.data[index + 2] = differs ? 0 : grey;
      out.data[index + 3] = 255;
    }
    context.putImageData(out, 0, 0);
    return { diff, total: first.width * first.height, size: `${first.width}x${first.height}`, png: canvas.toDataURL('image/png') };
  }, { a: `data:image/png;base64,${actual.toString('base64')}`, b: `data:image/png;base64,${expected.toString('base64')}`, boxes, delta: CHANNEL_DELTA });
}

before(async () => {
  scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-parity-'));
  // Chromium's singleton socket needs a short path even in long workspaces.
  const profile = await mkdtemp('/tmp/khala-parity-');
  await mkdir(OUT, { recursive: true });
  fixtureUrl = await serve({ root: WEB, build: { rollupOptions: { input: join(WEB, 'conversation-fixture.html') } } }, join(scratch, 'fixture'));
  // Always Playwright's default headless Chromium, as reference/capture.mjs uses: another
  // build (e.g. CI's CHROMIUM_PATH) rasterises text differently.
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profile } });
  comparePage = await browser.newPage();
  await comparePage.evaluate('globalThis.__name = f => f');
});

after(async () => {
  await writeFile(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  await browser?.close();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.httpServer.close(() => resolve()))));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

// --- §25.4 screens. ---

describe('screens', { concurrency: 1 }, () => {
  for (const c of SCREEN_CASES) {
    const name = `screens: ${screenName(c)}`;
    it(name, { timeout: 120_000, skip: SCREENS_SKIP }, async () => {
      const reference = await readFile(join(SCREENS, `fullbleed-${screenName(c)}.png`));
      const inject = await readFile(join(DESIGN, 'reference/fullbleed-inject.css'), 'utf8');
      const { masks, reserves } = await designLayout(browser!, c, inject);
      const { shot } = await captureFixture(c, reserves);
      const boxes = Object.values(masks).flat();
      const result = await pixelDiff(shot, reference, boxes);
      const diffPath = join(OUT, `${screenName(c)}.diff.png`);
      if (result.png) await writeFile(diffPath, Buffer.from(result.png.split(',')[1]!, 'base64'));
      await writeFile(join(OUT, `${screenName(c)}.fixture.png`), shot);
      const ratio = result.diff / result.total;
      const ceiling = screenCeiling(c);
      results.push({ check: 'screen', ...c, ratio: Number(ratio.toFixed(4)), ceiling: Number(ceiling.toFixed(4)), cause: screenCause(c),
        size: result.size, reserves,
        masks: Object.entries(masks).filter(([, list]) => list.length).map(([id]) => id), maskedPixels: boxes.reduce((sum, box) => sum + box[2] * box[3], 0) });
      assert.ok(result.diff >= 0, `screenshot size ${result.size}`);
      assert.ok(ratio <= ceiling, `${screenName(c)}: ${ratio.toFixed(4)} of pixels differ (> ${ceiling.toFixed(4)}); diff at ${diffPath}`);
    });
  }
});

// --- §25.2/§25.3 computed styles and tokens. ---

type ComputedEntry = Readonly<Record<string, string>> & Readonly<{ box: readonly number[] }>;
type ComputedReference = Readonly<Record<string, Readonly<Record<string, ComputedEntry | null>> & { ':root tokens': Readonly<Record<string, string>> }>>;

const EXACT = ['color', 'background-color', 'font-size', 'font-weight', 'font-family', 'padding', 'border-radius', 'border', 'line-height', 'letter-spacing'] as const;
/** Selectors with nothing to compare in M1, with the reason. */
const COMPUTED_SKIP: Readonly<Record<string, string>> = {
  '.kh-id': 'Executor decision (dec_f83838efca089ad3): #id badges are Aiur ticket numbers and M1 omits them; `.kh-id` renders only for colliding names',
};
const SIZE_ONLY = 'position follows text length or thread scroll; size compared';
/** Boxes that follow dataset text, thread scroll or an omitted neighbour; their styles are still compared. */
const BOX_SKIP: Readonly<Record<string, string>> = Object.fromEntries([
  ...['.kh-list-head span', '.kh-cv-t b', '.kh-cv-t time', '.kh-cv-pv', '.kh-head-t > b', '.kh-head-t > span', '.kh-head-t .on',
    '.kh-name', '.kh-name b', '.kh-otag', '.kh-htag', '.kh-mention', '.kh-mention.kh-hm', '.kh-b code', '.kh-ev',
    '.kh-rcpt', '.kh-chip-a', '.kh-chip-h', '.kh-day',
    '.kh-row:not(.me):not(.human) .kh-b', '.kh-row.human .kh-b', '.kh-row.me .kh-b', '.kh-row.failed .kh-b']
    .map(selector => [selector, 'text length or thread scroll position']),
  // CSS fixes these sizes, but their position follows dataset text or thread scroll: compare width and height only.
  ...['.kh-av', '.kh-own', '.kh-ev i', '.kh-retry', '.kh-to-tog'].map(selector => [selector, SIZE_ONLY]),
]);
/** Design selectors whose product element carries another class: KM-172's channel-event pill is the §8 `.kh-ev`. */
const SELECTOR_ALIASES: Readonly<Record<string, string>> = {
  '.kh-ev': '.channel-event-pill__link',
  '.kh-ev i': '.channel-event-pill__dot',
};
const COMPUTED_VIEWPORTS =[[1440, 'dark'], [1440, 'light'], [390, 'dark']] as const;

const computedMemo = new Map<string, Promise<Readonly<Record<string, ComputedEntry | null>>>>();
function fixtureComputed(width: number, theme: Theme, selectors: readonly string[], props: readonly string[], tokens: readonly string[]) {
  const key = `${width}-${theme}`;
  if (!computedMemo.has(key)) {
    computedMemo.set(key, (async () => {
      const { context, page } = await openFixture({ width, theme, state: 'thread' });
      try {
        return await page.evaluate(({ selectors: list, props: names, tokens: tokenNames, aliases }) => {
          const out: Record<string, unknown> = {};
          for (const selector of list) {
            const own = aliases[selector] ?? selector;
            const element = document.querySelector(`#kh-card ${own}`) ?? document.querySelector(own);
            if (!element) { out[selector] = null; continue; }
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            out[selector] = { box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
              ...Object.fromEntries(names.map(name => [name, style.getPropertyValue(name)])) };
          }
          const app = getComputedStyle(document.querySelector('.khala-app')!);
          out[':root tokens'] = Object.fromEntries(tokenNames.map(name => [name, app.getPropertyValue(name).trim()]));
          return out as Record<string, ComputedEntry | null>;
        }, { selectors, props, tokens, aliases: SELECTOR_ALIASES });
      } finally {
        await context.close();
      }
    })());
  }
  return computedMemo.get(key)!;
}

const reference = JSON.parse(await readFile(join(DESIGN, 'reference/computed-styles.json'), 'utf8')) as ComputedReference;

describe('computed', { concurrency: 1 }, () => {
  for (const [width, theme] of COMPUTED_VIEWPORTS) {
    const viewport = `${width}-${theme}`;
    const expected = reference[viewport]!;
    const selectors = Object.keys(expected).filter(selector => selector !== ':root tokens');
    const props = Object.keys(Object.values(expected).find(entry => entry && 'box' in entry) ?? {}).filter(prop => prop !== 'box');
    const tokens = Object.keys(expected[':root tokens']);
    const load = () => fixtureComputed(width, theme, selectors, props, tokens);

    const tokenName = `tokens: ${viewport}`;
    it(tokenName, { timeout: 60_000 }, async () => {
      // Custom properties keep their authored text: `.2` in the product is `0.20` in the design file.
      const normalize = (values: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(values)
        .map(([token, value]) => [token, value.replace(/\d*\.?\d+/gu, number => String(Number(number))).replace(/\s+/gu, ' ')]));
      const actual = normalize((await load())[':root tokens'] as unknown as Record<string, string>);
      const want = normalize(expected[':root tokens']);
      results.push({ check: 'tokens', viewport, mismatches: tokens.filter(token => actual[token] !== want[token]) });
      assert.deepEqual(actual, want);
    });

    for (const selector of selectors) {
      const name = `computed: ${viewport}: ${selector}`;
      const skip = COMPUTED_SKIP[selector] ?? (expected[selector] === null ? 'absent from the design at this viewport' : false);
      it(name, { timeout: 60_000, skip }, async () => {
        const deviation = COMPUTED_DEVIATIONS[selector];
        const want = { ...expected[selector]!, ...deviation?.values[viewport] };
        const got = (await load())[selector];
        assert.ok(got, `${selector} is rendered`);
        const mismatches = EXACT.filter(prop => got[prop] !== want[prop]).map(prop => `${prop}: ${got[prop]} ≠ ${want[prop]}`);
        const boxSkip = BOX_SKIP[selector];
        const compared = boxSkip === SIZE_ONLY ? [2, 3] : boxSkip ? [] : [0, 1, 2, 3];
        if (compared.some(index => Math.abs(want.box[index]! - got.box[index]!) > 2)) {
          mismatches.push(`box: [${got.box.join(', ')}] ≠ [${want.box.join(', ')}]${boxSkip ? ' (size)' : ''}`);
        }
        results.push({ check: 'computed', viewport, selector, mismatches, deviation: deviation?.reason ?? null,
          box: boxSkip && boxSkip !== SIZE_ONLY ? `skipped: ${boxSkip}` : got.box, boxCompared: compared.length === 2 ? 'size' : compared.length ? 'full' : 'none' });
        assert.deepEqual(mismatches, []);
      });
    }
  }
});

// --- §25.1 fonts. ---

function assertFonts(page: string, walk: FontWalk, options: Readonly<{ wordmark: boolean; googleLink: boolean }>) {
  results.push({ check: 'fonts', page, elements: walk.elements, wrong: walk.wrong, bungee: walk.bungee, wordmarks: walk.wordmarks, googleLink: walk.googleLink });
  assert.ok(walk.elements > 0, `${page}: renders .khala-app`);
  assert.deepEqual(walk.wrong, [], `${page}: every .khala-app element uses the design stacks`);
  assert.deepEqual(walk.bungee, [], `${page}: only the wordmark is Bungee`);
  if (options.wordmark) assert.ok(walk.wordmarks.length > 0 && walk.wordmarks.every(family => family.startsWith('Bungee')), `${page}: wordmark is Bungee`);
  if (options.googleLink) assert.equal(walk.googleLink, true, `${page}: the Google Fonts link is present verbatim`);
}

describe('fonts', { concurrency: 1 }, () => {
  for (const c of SCREEN_CASES) {
    const name = `fonts: fixture ${screenName(c)}`;
    it(name, { timeout: 60_000 }, async () => {
      assertFonts(`fixture ${screenName(c)}`, (await captureFixture(c)).fonts, { wordmark: c.width > 760 || c.state === 'list', googleLink: true });
    });
  }

  it('fonts: the app entry loads the Google Fonts stylesheet verbatim', async () => {
    const html = await readFile(join(WEB, 'index.html'), 'utf8');
    assert.ok(html.includes('<link href="https://fonts.googleapis.com/css2?family=Bungee&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />'));
  });

  describe('app routes (mocked ports)', { concurrency: 1 }, () => {
    let url = '';
    before(async () => {
      const root = join(WEB, 'src/composition/human/browser-harness');
      url = await serve({ root, build: { rollupOptions: { input: join(root, 'device-loss.html') } } }, join(scratch, 'app'));
    });
    for (const route of ['/channels/room_1', '/conversations']) {
      const name = `fonts: app ${route}`;
      it(name, { timeout: 60_000 }, async () => {
        const context = await newContext(browser!, 1440, 900, 'dark');
        try {
          const page = await context.newPage();
          await page.goto(`${url}device-loss.html?state=ready&logout&visual`);
          await page.locator('.kh-card .kh-cv').first().waitFor();
          if (route === '/conversations') {
            await page.evaluate(() => (window as unknown as { __lossHarness: { navigate(path: string): void } }).__lossHarness.navigate('/conversations'));
            await page.locator('.khala-empty-conversation').waitFor();
          }
          await page.waitForTimeout(200);
          assertFonts(`app ${route}`, await page.evaluate(walkFonts), { wordmark: true, googleLink: false });
        } finally {
          await context.close();
        }
      });
    }
  });

  describe('sign-in redirect and confirm page', { concurrency: 1 }, () => {
    let url = '';
    before(async () => {
      url = await serve({ root: join(WEB, 'src/features/agent-confirm/browser-harness') }, join(scratch, 'confirm'));
    });

    it('fonts: sign-in redirect card', { timeout: 60_000 }, async () => {
      const context = await newContext(browser!, 1440, 900, 'dark');
      try {
        const page = await context.newPage();
        // A 204 login cancels the redirect, so the redirect card stays on screen.
        await page.route('**/api/human/auth/login?**', route => route.fulfill({ status: 204 }));
        await page.goto(`${url}?signedOut=1&path=/conversations`, { waitUntil: 'commit' });
        await page.getByText('Signing in…').waitFor();
        assertFonts('sign-in redirect', await page.evaluate(walkFonts), { wordmark: true, googleLink: false });
      } finally {
        await context.close();
      }
    });

    it('fonts: agent confirm page', { timeout: 60_000 }, async () => {
      const context = await newContext(browser!, 1440, 900, 'dark');
      try {
        const page = await context.newPage();
        await mockConfirm(page);
        await page.goto(url);
        await page.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
        assertFonts('agent confirm', await page.evaluate(walkFonts), { wordmark: true, googleLink: false });
      } finally {
        await context.close();
      }
    });

    it('sign-in: a signed-out /conversations goes straight to the login URL, with no sign-in page', { timeout: 60_000 }, async () => {
      const context = await newContext(browser!, 1440, 900, 'dark');
      try {
        const page = await context.newPage();
        const logins: string[] = [];
        await page.route('**/api/human/auth/login?**', route => {
          logins.push(route.request().url());
          return route.fulfill({ status: 204 });
        });
        await page.goto(`${url}?signedOut=1&path=/conversations`, { waitUntil: 'commit' });
        await page.getByText('Signing in…').waitFor();
        await page.waitForTimeout(300);
        assert.equal(logins.length, 1);
        assert.equal(new URL(logins[0]!).searchParams.get('return_to'), '/conversations');
        assert.equal(await page.getByRole('button', { name: /sign in/iu }).count(), 0);
        assert.equal(await page.getByRole('heading').count(), 0);
      } finally {
        await context.close();
      }
    });
  });
});

async function mockConfirm(page: Page) {
  await page.route('**/api/human/me', route => route.fulfill({ json: {
    principal: { v: 1, ownerId: 'owner_alice', providerIssuer: 'https://issuer.example', providerSubject: 'alice',
      verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z' }, csrfToken: 'browser-proof',
  } }));
  await page.route('**/api/human/agent-join?*', route => route.fulfill({ json:
    { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' } }));
}

// --- §25.5–10 behaviour and structure, on the fixture. ---

async function withFixture<T>(c: ScreenCase, run: (page: Page) => Promise<T>, query?: string): Promise<T> {
  const { context, page } = await openFixture(c, query);
  try {
    return await run(page);
  } finally {
    await context.close();
  }
}
const CHANNELS = ['release', 'pagination', 'docs-launch', 'nav-auth', 'theming', 'ci'];
const at1440 = (state: State, theme: Theme = 'dark'): ScreenCase => ({ width: 1440, theme, state });

describe('behaviour', { concurrency: 1 }, () => {
  it('runs: rows group into first / mid / last-of runs, with the name on the first and ghosts on all but the last', { timeout: 60_000 }, async () => {
    const runs = await withFixture(at1440('thread'), async page => {
      const found: { channel: string; classes: string[]; names: boolean[]; ghosts: boolean[] }[] = [];
      for (const channel of CHANNELS) {
        await page.locator(`[data-kh-convo="${channel}"]`).click();
        await page.waitForTimeout(150);
        found.push(...await page.evaluate(id => {
          const out: { channel: string; classes: string[]; names: boolean[]; ghosts: boolean[] }[] = [];
          let current: Element[] = [];
          const flush = () => {
            if (current.length) out.push({ channel: id, classes: current.map(row => ['first', 'mid', 'last-of'].find(name => row.classList.contains(name)) ?? 'none'),
              names: current.map(row => row.querySelector('.kh-name') !== null), ghosts: current.map(row => row.querySelector('.kh-av.ghost') !== null) });
            current = [];
          };
          for (const item of document.querySelectorAll('.kh-thread > ul > li, .kh-thread li')) {
            if (!item.classList.contains('kh-row')) { if (!item.classList.contains('kh-rcpt')) flush(); continue; }
            if (item.classList.contains('first')) flush();
            current.push(item);
          }
          flush();
          return out;
        }, channel));
      }
      return found;
    });
    for (const run of runs) {
      const expected = run.classes.length === 1 ? ['first'] : ['first', ...Array(run.classes.length - 2).fill('mid'), 'last-of'];
      assert.deepEqual(run.classes, expected, `${run.channel}: run classes`);
      const me = run.names.every(name => !name) && run.ghosts.every(ghost => !ghost);
      if (!me) assert.deepEqual(run.names, run.classes.map((_, index) => index === 0), `${run.channel}: the name line is on the first row only`);
      if (!me) assert.deepEqual(run.ghosts, run.classes.map((_, index) => index < run.classes.length - 1), `${run.channel}: ghosts on all but the last`);
    }
    const longest = Math.max(...runs.map(run => run.classes.length));
    results.push({ check: 'runs', runs: runs.length, longest });
    assert.ok(longest >= 2, 'the fixture has a multi-row run');
  });

  it('ownership: the viewer is .me with no avatar; the viewer’s agents are left rows tagged “Your machine”; other humans are .human', { timeout: 60_000 }, async () => {
    await withFixture(at1440('thread'), async page => {
      const rows = await page.locator('.kh-thread .kh-row').evaluateAll(list => list.map(row => ({
        me: row.classList.contains('me'), human: row.classList.contains('human'), avatar: row.querySelector('.kh-av') !== null,
        name: row.querySelector('.kh-name b')?.textContent ?? null, tag: row.querySelector('.kh-otag, .kh-htag')?.textContent ?? null,
        tagTransform: row.querySelector('.kh-otag') ? getComputedStyle(row.querySelector('.kh-otag')!).textTransform : null,
        justify: getComputedStyle(row).justifyContent,
      })));
      const mine = rows.filter(row => row.me);
      assert.ok(mine.length >= 2);
      assert.ok(mine.every(row => !row.avatar && !row.human), 'the viewer’s rows are .me without an avatar');
      const yourMachine = rows.filter(row => row.tag === 'Your machine');
      assert.ok(yourMachine.length >= 1, 'the viewer’s agents carry “Your machine”');
      assert.ok(yourMachine.every(row => !row.me && row.avatar && row.tagTransform === 'uppercase'), 'agent rows are left-aligned, uppercase tag');
      const humans = rows.filter(row => row.human);
      assert.deepEqual([...new Set(humans.map(row => row.name).filter(Boolean))].sort(), ['Kai Watanabe', 'Maya Chen']);
    });
  });

  it('receipt: exactly one, after the viewer’s last message, never “Read”', { timeout: 60_000 }, async () => {
    const seen = await withFixture(at1440('thread'), async page => {
      const out: { channel: string; texts: string[]; afterLastMine: boolean; retry: number }[] = [];
      for (const channel of CHANNELS) {
        await page.locator(`[data-kh-convo="${channel}"]`).click();
        await page.waitForTimeout(150);
        out.push({ channel, ...await page.evaluate(() => {
          const items = [...document.querySelectorAll('.kh-thread li')];
          const receipts = items.filter(item => item.classList.contains('kh-rcpt'));
          const lastMine = items.map(item => item.classList.contains('me')).lastIndexOf(true);
          return { texts: receipts.map(item => item.textContent?.trim() ?? ''),
            afterLastMine: receipts.length === 1 && items.indexOf(receipts[0]!) === lastMine + 1,
            retry: document.querySelectorAll('.kh-thread .kh-retry').length };
        }) });
      }
      return out;
    });
    results.push({ check: 'receipt', seen });
    for (const { channel, texts, afterLastMine, retry } of seen) {
      assert.equal(texts.length, 1, `${channel}: one receipt`);
      assert.equal(afterLastMine, true, `${channel}: after the viewer’s last message`);
      assert.ok(!/read/iu.test(texts[0]!), `${channel}: never “Read”`);
      if (channel === 'release') {
        assert.match(texts[0]!, /Not sent/u);
        assert.equal(retry, 1, 'Not sent carries Retry');
      } else {
        assert.equal(texts[0], 'Delivered');
      }
    }
  });

  it('chips: the viewer’s agents first, then each human and their agents; a toggle only past 3; the grid drops an agentless viewer', { timeout: 60_000 }, async () => {
    await withFixture(at1440('thread'), async page => {
      const chips = () => page.evaluate(() => ({
        flat: [...document.querySelectorAll('.kh-to-flat .kh-chip')].map(chip => chip.textContent),
        toggle: document.querySelectorAll('.kh-to-tog').length,
      }));
      const release = await chips();
      assert.deepEqual(release.flat, ['@OpusYO', '@SonnetYO', 'MC@Maya']);
      assert.equal(release.toggle, 1);
      await page.locator('.kh-to-tog').click();
      const grid = await page.evaluate(() => [...document.querySelectorAll('.kh-to-grid > *')].map(group => group.textContent));
      assert.deepEqual(grid, ['YOYou', '@OpusYO@SonnetYO', 'MC@Maya', '@CodexMC@CodexMC', 'KW@Kai', '@SonnetKW@SonnetKW']);
      results.push({ check: 'chips', release, grid });

      await page.locator('[data-kh-convo="ci"]').click();
      await page.waitForTimeout(150);
      const ci = await chips();
      assert.deepEqual(ci.flat, ['@OpusYO']);
      assert.equal(ci.toggle, 0, 'no toggle with 3 or fewer chips');

      await page.locator('[data-kh-convo="docs-launch"]').click();
      await page.waitForTimeout(150);
      if (await page.locator('.kh-to-tog').count()) {
        await page.locator('.kh-to-tog').click();
        const viewerRow = await page.locator('.kh-to-grid .kh-chip-me').count();
        assert.equal(viewerRow, 0, 'no viewer row without viewer agents');
      }
    });
  });

  for (const theme of ['dark', 'light'] as const) {
    it(`D1: ${theme} human chips are hsl(oh ${theme === 'dark' ? '70% 72%' : '60% 36%'})`, { timeout: 60_000 }, async () => {
      await withFixture(at1440('chips', theme), async page => {
        const chips = await page.locator('.kh-chip-h:not(.kh-chip-me)').evaluateAll((list, lightness) => list.map(chip => {
          const oh = getComputedStyle(chip).getPropertyValue('--oh').trim();
          const probe = document.createElement('span');
          probe.style.color = `hsl(${oh} ${lightness})`;
          document.body.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return { oh, actual: getComputedStyle(chip).color, expected };
        }), theme === 'dark' ? '70% 72%' : '60% 36%');
        results.push({ check: 'D1', theme, chips });
        assert.ok(chips.length >= 2);
        for (const chip of chips) assert.equal(chip.actual, chip.expected, `oh ${chip.oh}`);
      });
    });
  }

  it('D2: a closed detail sheet leaves no strip at 390px', { timeout: 60_000 }, async () => {
    await withFixture({ width: 390, theme: 'dark', state: 'thread' }, async page => {
      assert.equal(await page.locator('.kh-detail').evaluate(element => getComputedStyle(element).visibility), 'hidden');
      assert.equal(await page.locator('.kh-detail').isVisible(), false);
    });
  });

  it('D3: the owner pill text is .78rem', { timeout: 60_000 }, async () => {
    // Another owner's agent: its pill names the owner in a <b> and a <span>.
    await withFixture(at1440('detail-agent'), async page => {
      for (const part of ['.kh-d-owner b', '.kh-d-owner > span']) {
        assert.equal(await page.locator(part).first().evaluate(element => getComputedStyle(element).fontSize), '12.48px', part);
      }
    }, 'failed=1&detail=AIUR-620');
  });

  it('D5: a human detail’s agent avatars are 32×32', { timeout: 60_000 }, async () => {
    await withFixture(at1440('detail-human'), async page => {
      const boxes = await page.locator('.kh-d-agent > .kh-av').evaluateAll(list => list.map(element => {
        const rect = element.getBoundingClientRect();
        return [Math.round(rect.width), Math.round(rect.height)];
      }));
      assert.ok(boxes.length >= 1);
      for (const box of boxes) assert.deepEqual(box, [32, 32]);
    });
  });

  it('D6: “Recent in Khala” draws @mentions as the thread’s mention chips', { timeout: 60_000 }, async () => {
    await withFixture(at1440('detail-human'), async page => {
      // Kai's “@Sonnet ship the contrast fixes” (fixture-data.ts).
      assert.ok((await page.locator('.kh-d-log .kh-mention').allTextContents()).includes('@Sonnet'));
    });
  });

  it('m1-matrix: every §22 Omit element is absent; every Disabled control is disabled with “Coming soon”', { timeout: 120_000 }, async () => {
    const OMIT = ['.kh-ask', '.kh-badge', '.kh-req', '.kh-crw', '.kh-rai-p', '.kh-d-bar', '.kh-d-kv dt:nth-of-type(5)', '#kh-d-open',
      '.kh-keb', '.kh-confirm', '.kh-react', '.kh-typing', '[data-kh-act="settings"]', '.kh-list-foot', '.kh-cv.dead', '.kh-fin',
      '.kh-st', '.kh-d-agent > i', '.kh-rcpt.read'];
    const states: State[] = ['thread', 'roster', 'detail-agent', 'detail-human', 'pop-invite', 'pop-new', 'chips'];
    const present: string[] = [];
    for (const state of states) {
      await withFixture(at1440(state), async page => {
        for (const selector of OMIT) if (await page.locator(selector).count()) present.push(`${state}: ${selector}`);
        if (state === 'pop-invite') {
          const disabled = await page.locator('.kh-pop .kh-seg button, .kh-pop .kh-sw').evaluateAll(list => list.map(control =>
            (control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true') && control.getAttribute('title') === 'Coming soon'));
          assert.ok(disabled.length >= 5 && disabled.every(Boolean), 'invite Type / Approve joins / History are disabled “Coming soon”');
        }
        if (state === 'roster') {
          const modes = await page.locator('.kh-roster .kh-seg.ic button').evaluateAll(list => list.map(control =>
            control.hasAttribute('disabled') && control.getAttribute('title') === 'Coming soon'));
          assert.ok(modes.length >= 3 && modes.every(Boolean), 'listening modes are disabled “Coming soon”');
        }
      });
    }
    results.push({ check: 'm1-matrix', present });
    assert.deepEqual(present, []);
  });
});

// --- §25.11 Sign In on the landing page. ---

describe('sign-in', { concurrency: 1 }, () => {
  it('sign-in: the landing page has one top-right Sign in link with the .tool-btn metrics and no “Open Khala app”', { timeout: 90_000 }, async () => {
    const configFile = join(WEB, 'vite.landing.config.mjs');
    const url = await serve({ configFile }, join(scratch, 'landing'));
    const context = await newContext(browser!, 1440, 900, 'dark');
    try {
      const page = await context.newPage();
      await page.goto(url);
      assert.equal(await page.getByText('Open Khala app').count(), 0);
      const link = page.locator('.topbar').getByRole('link', { name: 'Sign in' });
      assert.equal(await link.getAttribute('href'), '/api/human/auth/login?return_to=%2Fconversations');
      const style = await link.evaluate(element => {
        const computed = getComputedStyle(element);
        return { family: computed.fontFamily, size: computed.fontSize, radius: computed.borderTopLeftRadius, border: computed.borderTopWidth, borderStyle: computed.borderTopStyle };
      });
      results.push({ check: 'sign-in', style });
      assert.ok(style.family.startsWith('"JetBrains Mono"'), style.family);
      assert.equal(style.size, '12.16px');
      assert.equal(style.radius, '999px');
      assert.equal(style.border, '1px');
      assert.equal(style.borderStyle, 'solid');
    } finally {
      await context.close();
    }
  });
});
