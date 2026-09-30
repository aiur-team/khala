import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = join(here, '../../vite.landing.config.mjs');

test('public showcase stays local and works across themes and widths', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-showcase-dist-'));
  // Chromium's singleton socket has a short path limit.
  const profile = await mkdtemp(join('/tmp', 'ks546-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ configFile, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ configFile, build: { outDir }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profile } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const calls: string[] = [];
    page.on('request', request => { if (/\/(api|_matrix|auth)\//.test(new URL(request.url()).pathname)) calls.push(request.url()); });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]!);
    const pane = page.locator('#exampleShowcase');
    const list = pane.getByRole('complementary', { name: 'Conversations' });
    const thread = pane.getByRole('region', { name: 'Conversation thread' });
    assert.equal(await page.locator('.showcase-section').evaluate(node => node.previousElementSibling?.classList.contains('stage')), true);
    assert.equal(await page.locator('.showcase-section').evaluate(node => node.nextElementSibling?.classList.contains('feature-section')), true);
    assert.equal(await page.getByRole('link', { name: 'Open Khala app' }).getAttribute('href'), '/new');
    assert.equal(await page.getByRole('button', { name: 'Copy the prompt' }).count(), 1);
    await page.getByRole('button', { name: 'Copy the prompt' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Open a channel with another agent: https://khala.aiur.team');
    assert.equal(await page.getByText(' · example').count(), 0);
    assert.equal(await page.getByText('Khala conversation preview').count(), 0);
    assert.equal(await page.getByText('EXAMPLE · LOCAL ONLY').count(), 0);
    assert.equal(await page.getByText('Open the real Khala app').count(), 0);
    assert.equal(await pane.getByRole('button', { name: 'Participants and agents' }).count(), 1);
    assert.equal(await pane.getByRole('button', { name: 'Send message' }).getAttribute('aria-describedby'), 'showcase-local-note');
    assert.equal(await pane.getByRole('textbox', { name: 'Message' }).getAttribute('aria-describedby'), 'showcase-local-note');
    assert.equal(await pane.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder') ?? '', '');
    assert.match(await pane.locator('#showcase-local-note').textContent() ?? '', /not sent to agents/);

    const participantButton = pane.getByRole('button', { name: 'Participants and agents' });
    await participantButton.click();
    assert.equal(await participantButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await pane.locator('.showcase-app__participants').getByText('Dolan').isVisible(), true);
    await participantButton.click();
    assert.equal(await participantButton.getAttribute('aria-expanded'), 'false');

    assert.equal(await pane.getByText('Codex #420 is now called Dolan').count(), 1);
    assert.equal(await pane.getByText('Changed by Maya').count(), 1);
    assert.equal(await pane.locator('.conversation-message__meta strong').filter({ hasText: 'Codex #420' }).count(), 1);
    assert.equal(await pane.locator('.conversation-message__meta strong').filter({ hasText: 'Dolan' }).count(), 1);

    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') await page.getByRole('button', { name: 'Dark mode' }).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      for (const width of [1440, 1100, 900, 760, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const dimensions = await page.locator('.showcase-window').evaluate(node => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height, left: box.left, right: box.right };
        });
        const overlap = await page.evaluate(() => document.querySelector('.stage')!.getBoundingClientRect().bottom - document.querySelector('.showcase-window')!.getBoundingClientRect().top);
        assert.ok(overlap >= 63 && overlap <= 105, `${theme} ${width}: hero overlap`);
        assert.ok(dimensions.width <= Math.min(1000, width), `${theme} ${width}: width`);
        assert.ok(dimensions.height >= 420 && dimensions.height <= 660, `${theme} ${width}: height`);
        assert.ok(dimensions.left >= 0 && dimensions.right <= width, `${theme} ${width}: frame in viewport`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width}: no overflow`);
        if (width <= 900) {
          await pane.getByRole('button', { name: 'All conversations' }).click();
          assert.equal(await list.isVisible(), true);
        }
        await pane.getByRole('button', { name: 'Design' }).click();
        assert.equal(await thread.getByText('The smaller layout keeps the back control visible.').isVisible(), true);
        const positions = await pane.locator('.fixture-messages .conversation-message').evaluateAll(nodes => nodes.map(node => {
          const message = node.getBoundingClientRect();
          const bubble = node.querySelector('.conversation-message__bubble')!.getBoundingClientRect();
          const style = getComputedStyle(node.querySelector('.conversation-message__bubble')!);
          return { left: message.left, right: message.right, bubbleLeft: bubble.left, bubbleRight: bubble.right,
            radius: style.borderRadius, fontSize: getComputedStyle(node.querySelector('.conversation-message__content')!).fontSize };
        }));
        assert.equal(positions.length, 3);
        assert.ok(positions[0]!.right > positions[1]!.right, `${theme} ${width}: owner message aligns right`);
        assert.ok(positions[1]!.left < positions[0]!.left, `${theme} ${width}: peer message aligns left`);
        assert.ok(positions[2]!.left < positions[0]!.left, `${theme} ${width}: agent message aligns left`);
        assert.ok(positions.every(position => position.bubbleLeft >= dimensions.left && position.bubbleRight <= dimensions.right), `${theme} ${width}: bubbles fit the frame`);
        assert.equal(positions[0]!.radius, '6px', `${theme} ${width}: shared Dashboard card radius`);
        assert.equal(positions[0]!.fontSize, '13.12px', `${theme} ${width}: shared Dashboard message type size`);
        const details = pane.getByRole('button', { name: 'Participants and agents' });
        assert.equal(await details.evaluate(node => node.closest('.conversation-thread__head') !== null), true);
        assert.equal(await details.evaluate(node => Math.round(node.getBoundingClientRect().width)), 44);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await details.focus();
        assert.equal(await details.evaluate(node => getComputedStyle(node).outlineWidth), '3px');
        await details.press('Enter');
        assert.equal(await details.getAttribute('aria-expanded'), 'true');
        assert.equal(await pane.locator('.showcase-app__participants').getByText('Jordan’s agent').isVisible(), true);
        await pane.getByText('Agent participation').click();
        assert.equal(await pane.getByText('This preview is local and has no connected agents.').isVisible(), true);
        await pane.getByRole('button', { name: 'Close details' }).click();
        assert.equal(await details.getAttribute('aria-expanded'), 'false');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await pane.getByRole('button', { name: 'All conversations' }).click();
    assert.equal(await list.isVisible(), true);
    await pane.getByRole('button', { name: 'Handoff' }).click();
    assert.equal(await thread.getByText('I’ve outlined the next steps for both owners.').isVisible(), true);
    await participantButton.press('Space');
    assert.equal(await participantButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await pane.locator('.showcase-app__participants').getByText('Priya’s agent').isVisible(), true);
    await pane.getByRole('button', { name: 'Close details' }).click();
    await pane.getByRole('textbox', { name: 'Message' }).fill('A local note');
    await pane.getByRole('button', { name: 'Send message' }).click();
    assert.equal(await pane.getByText('A local note').isVisible(), true);
    await pane.getByRole('textbox', { name: 'Message' }).fill('An Enter note');
    await pane.getByRole('textbox', { name: 'Message' }).press('Enter');
    assert.equal(await pane.getByText('An Enter note').isVisible(), true);
    await pane.getByRole('textbox', { name: 'Message' }).fill('First line');
    await pane.getByRole('textbox', { name: 'Message' }).press('Shift+Enter');
    assert.equal(await pane.getByRole('textbox', { name: 'Message' }).inputValue(), 'First line\n');
    await pane.getByRole('textbox', { name: 'Message' }).type('Second line');
    await pane.getByRole('textbox', { name: 'Message' }).press('Enter');
    const multiline = pane.locator('.fixture-messages .conversation-message--mine').last();
    assert.equal(await multiline.locator('.conversation-message__content').textContent(), 'First line\nSecond line');
    assert.equal(await multiline.locator('.conversation-message__content').evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
    await page.reload();
    assert.equal(await page.getByText('A local note').count(), 0, 'local text is not persisted');
    assert.equal(await page.getByText('An Enter note').count(), 0, 'Enter text is not persisted');
    assert.equal(await page.getByText('First line Second line').count(), 0, 'multiline local text is not persisted');
    assert.deepEqual(calls, [], 'no chat or auth requests');
    assert.deepEqual(errors, [], 'no browser errors');
    await context.close();
  } finally {
    await browser?.close();
    await server?.httpServer.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
