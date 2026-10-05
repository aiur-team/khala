import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

const focused = (page: Page, selector: string) => page.locator(selector).evaluate(element => document.activeElement === element);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('channel header, roster, popovers and detail pane', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-channel-dist-'));
  // Chromium's singleton socket has a strict path-length cap; the workspace's
  // private TMPDIR is too deep, while mkdtemp keeps this shared /tmp path unique.
  const chromiumProfileRoot = await mkdtemp('/tmp/khala-channel-profile-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const url = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(url);

    // Creator authority, quiet removal confirmation, and responsive visual proof.
    await page.locator('#kh-head-btn').click();
    assert.equal(await page.locator('.kh-owner-tag').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Remove Mira', exact: true }).count(), 0);
    const removeTheo = page.getByRole('button', { name: 'Remove Theo Park', exact: true });
    await removeTheo.click();
    await page.getByRole('dialog', { name: 'Remove Theo Park' }).waitFor();
    assert.match(await page.locator('.kh-remove-agents').textContent() ?? '', /Builder/);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await removeTheo.count(), 1);
    await removeTheo.click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog', { name: 'Remove Theo Park' }).count(), 0);
    await removeTheo.click();
    await page.locator('.kh-brand').click({position:{x:10,y:10}});
    assert.equal(await page.getByRole('dialog', { name: 'Remove Theo Park' }).count(), 0);
    const screenshotDir = join(here, '../../../../../docs/screenshots/1095');
    await mkdir(screenshotDir, {recursive:true});
    for (const theme of ['light', 'dark']) {
      for (const width of [390, 1280]) {
        await page.setViewportSize({width, height:900});
        await page.goto(`${url}?theme=${theme}&twoagents`);
        await page.locator('#kh-head-btn').click();
        await page.waitForTimeout(300);
        await page.screenshot({path:join(screenshotDir, `owner-roster-${theme}-${width}.png`)});
        await removeTheo.click();
        await page.getByRole('dialog', { name: 'Remove Theo Park' }).waitFor();
        assert.match(await page.locator('.kh-remove-agents').textContent() ?? '', /Builder, Atlas/);
        assert.equal(await noOverflow(page), true);
        await page.waitForTimeout(300);
        await page.screenshot({path:join(screenshotDir, `owner-remove-${theme}-${width}.png`)});
      }
    }
    await page.getByRole('button', {name:'Remove', exact:true}).click();
    await page.getByText('You · 1 human · 1 agent', {exact:true}).waitFor();
    assert.equal(await removeTheo.count(), 0);
    await page.goto(`${url}?nonowner`);
    await page.locator('#kh-head-btn').click();
    assert.equal(await page.locator('.kh-owner-tag').count(), 1);
    assert.equal(await removeTheo.count(), 0);
    await page.setViewportSize({width:1440,height:900});
    await page.goto(url);

    // Header (§5).
    const headButton = page.locator('#kh-head-btn');
    await page.getByText('You, Theo · 2 humans · 2 agents').waitFor();
    assert.equal(await page.getByRole('heading', { level: 1, name: 'Release channel' }).count(), 1);
    assert.equal(await page.locator('.kh-stack .kh-av').count(), 3);
    assert.equal(await page.locator('.kh-hacts .kh-ib').count(), 1, 'Invite only; no settings gear in M1');

    // Roster toggles from the header and starts inert.
    const roster = page.locator('#kh-roster');
    assert.equal(await roster.getAttribute('inert'), '');
    await headButton.click();
    assert.equal(await headButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.kh-channel').evaluate(element => element.classList.contains('roster-open')), true);
    assert.equal(await roster.getAttribute('inert'), null);
    assert.equal(await page.locator('#chips-closed').textContent(), '1', 'opening the roster closes the chips grid');
    assert.match(await page.locator('.kh-main').evaluate(element => element.style.getPropertyValue('--kh-head-h')), /^\d+px$/);
    const scout = page.locator('.kh-rai[data-kh-agent="agent_scout"]').locator('..');
    assert.equal(await scout.locator('[role="radio"]:not([disabled]):not([title])').count(), 3);
    assert.equal(await scout.locator('[role="radio"][aria-checked="true"]').getAttribute('data-v'), 'sync');
    const builderMode = page.locator('.kh-rai[data-kh-agent="agent_builder"]').locator('..').locator('.kh-mode-ro');
    assert.equal(await builderMode.getAttribute('data-tip'), 'Async · on demand', 'another person’s agent shows its actual mode');

    // Listening modes are live: the request shows at once, then the agent confirms.
    await scout.locator('[role="radio"][data-v="steer"]').click();
    assert.equal(await scout.locator('[role="radio"][aria-checked="true"]').getAttribute('data-v'), 'steer');
    const modeStatus = roster.locator('.kh-mode-status');
    await roster.getByRole('status').filter({ hasText: 'Waiting for Scout to switch…' }).waitFor();
    await modeStatus.waitFor({ state: 'hidden' });
    assert.equal(await modeStatus.textContent(), '');
    assert.equal(await scout.locator('[role="radio"][aria-checked="true"]').getAttribute('data-v'), 'steer');

    // Escape closes the roster and returns focus to the header button.
    await page.locator('.kh-rh[data-kh-human="p_theo"]').focus();
    await page.keyboard.press('Escape');
    assert.equal(await headButton.getAttribute('aria-expanded'), 'false');
    assert.equal(await focused(page, '#kh-head-btn'), true);

    // A click in the thread closes it.
    await headButton.click();
    const thread = (await page.locator('.kh-channel-thread').boundingBox())!;
    await page.mouse.click(thread.x + 20, thread.y + thread.height - 10);
    assert.equal(await headButton.getAttribute('aria-expanded'), 'false');

    // Invite popover (§12.3): live link, locked M2 options, toast on copy.
    await page.getByRole('button', { name: 'Invite' }).click();
    const pop = page.locator('.kh-pop');
    await pop.locator('.kh-link code', { hasText: 'https://khala.example/c/release' }).waitFor();
    assert.equal(await pop.locator('button[disabled][title="Coming soon"]').count(), 5);
    await pop.getByRole('button', { name: 'Copy link' }).click();
    await page.locator('.kh-toast.on', { hasText: 'Copied' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__copied), ['https://khala.example/c/release']);
    await page.keyboard.press('Escape');
    assert.equal(await pop.isHidden(), true);

    // Add agent popover copies the same link.
    await headButton.click();
    await page.getByRole('button', { name: 'Add agent' }).click();
    await pop.getByRole('button', { name: 'Copy link' }).click();
    await page.waitForFunction(() => window.__copied.length === 2);
    assert.equal(await pop.locator('.kh-hint').first().textContent(), 'paste into your agent');
    await page.keyboard.press('Escape');

    // Rename from the roster: only the viewer's own agents, opening the pane with the field focused.
    assert.equal(await page.getByRole('button', { name: 'Rename Builder' }).count(), 0, 'no roster rename for another person’s agent');
    await page.getByRole('button', { name: 'Rename Scout' }).click();
    const renaming = page.getByRole('complementary', { name: 'Scout details' });
    await renaming.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Name for Scout');
    const nameField = renaming.getByLabel('Name for Scout');
    assert.equal(await nameField.getAttribute('maxlength'), '40');
    assert.equal(await nameField.getAttribute('aria-invalid'), null);
    assert.equal(await nameField.getAttribute('aria-describedby'), null);
    assert.equal(await renaming.getByRole('alert').count(), 0, 'no rule text while the name is valid');
    await nameField.fill('a');
    const ruleError = renaming.getByRole('alert');
    assert.equal(await ruleError.textContent(), 'At least 2 characters.');
    assert.equal(await nameField.getAttribute('aria-invalid'), 'true');
    assert.equal(await nameField.getAttribute('aria-describedby'), await ruleError.getAttribute('id'));
    assert.equal(await renaming.getByRole('button', { name: 'Rename' }).isDisabled(), true);
    await nameField.fill('Builder');
    await renaming.getByRole('button', { name: 'Rename' }).click();
    await renaming.getByRole('alert').filter({ hasText: 'That name is taken.' }).waitFor();
    await renaming.getByRole('button', { name: 'Close details' }).click();

    // Detail (§11) from a roster row; rename for the viewer's own agent.
    await page.locator('.kh-rai[data-kh-agent="agent_scout"]').click();
    const detail = page.getByRole('complementary', { name: 'Scout details' });
    await detail.waitFor();
    assert.equal(await detail.locator('.kh-d-owner').textContent(), 'YOYour agent');
    assert.equal(await detail.locator('.kh-d-kv dt').allTextContents().then(items => items.join(',')), 'Harness,Owner,Joined');
    assert.equal(await detail.locator('.kh-d-log > div').count(), 2);
    assert.equal(await detail.locator('.kh-d-log time').first().getAttribute('datetime'), '2026-10-01T16:52:00Z');
    await detail.getByRole('button', { name: '@ Mention' }).click();
    assert.equal(await page.getByLabel('Message').inputValue(), '@Scout ');
    await detail.getByLabel('Name for Scout').fill('Dolan');
    await detail.getByRole('button', { name: 'Rename' }).click();
    await page.getByRole('complementary', { name: 'Dolan details' }).waitFor();

    // The owner pill of someone else's agent opens the owner; the human pane lists their agents.
    if (await headButton.getAttribute('aria-expanded') === 'false') await headButton.click();
    await page.locator('.kh-rai[data-kh-agent="agent_builder"]').click();
    const builder = page.getByRole('complementary', { name: 'Builder details' });
    assert.equal(await builder.locator('.kh-d-owner').textContent(), 'TPOwned by Theo Park');
    assert.equal(await builder.getByLabel('Name for Builder').count(), 0, 'no rename for another person’s agent');
    await builder.locator('.kh-d-owner').click();
    const theo = page.getByRole('complementary', { name: 'Theo Park’s details' });
    await theo.waitFor();
    assert.equal(await theo.locator('.kh-d-hero > span:last-child').textContent(), 'Owner of 1 agent');
    assert.equal(await theo.locator('.kh-d-hero .kh-email').textContent(), 'theo.park@example.com');
    await theo.getByRole('button', { name: '@ Mention Theo' }).click();
    assert.equal(await page.getByLabel('Message').inputValue(), '@Scout @Theo ');

    // Re-selecting the open participant closes the pane; so does the participant leaving.
    await page.getByRole('button', { name: 'Theo Park' }).first().click();
    assert.equal(await page.locator('.kh-card.has-detail').count(), 0);
    if (await headButton.getAttribute('aria-expanded') === 'true') await headButton.click();
    await page.getByRole('button', { name: '@Scout' }).click();
    await page.getByRole('complementary', { name: 'Dolan details' }).waitFor();
    await page.getByRole('button', { name: '@Scout' }).click();
    assert.equal(await page.locator('.kh-card.has-detail').count(), 0);
    await page.locator('.kh-stack .kh-av[aria-label="Builder"]').click();
    await builder.waitFor();
    await page.getByRole('button', { name: 'Builder leaves' }).click();
    await page.waitForFunction(() => !document.querySelector('.kh-card.has-detail'));

    // Crowded channel: four stacked avatars, then +N.
    await page.getByRole('button', { name: 'Show crowd' }).click();
    await page.getByRole('button', { name: 'Kai joins' }).click();
    await page.getByText('You, Theo, Kai · 3 humans · 5 agents').waitFor();
    assert.equal(await page.locator('.kh-stack button.kh-av').count(), 4);
    assert.equal(await page.locator('.kh-stack .kh-more').textContent(), '+3');
    await headButton.click();
    assert.equal(await page.locator('.kh-rh em', { hasText: 'Not in this channel' }).count(), 1);
    assert.deepEqual(await page.locator('.kh-rh .kh-email').allTextContents(), ['mira@example.com', 'theo.park@example.com'],
      'the roster shows each human’s email when known, and nothing for a human without one');
    for (const absent of ['.kh-keb', '.kh-crw', '.kh-confirm', '.kh-req', '.kh-badge', '.kh-st']) {
      assert.equal(await page.locator(absent).count(), 0, `${absent} is M2`);
    }

    // Phone width: back button, mode button instead of the segment, no overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.kh-back').isVisible(), true);
    assert.equal(await page.locator('.kh-seg.ic').first().isVisible(), false);
    assert.equal(await page.locator('.kh-mode-btn').first().isVisible(), true);
    assert.equal(await noOverflow(page), true, 'phone roster has no horizontal overflow');
    // The narrow mode menu (source:4427).
    const modeButton = page.locator('.kh-rai[data-kh-agent="agent_scout"]').locator('..').locator('.kh-mode-btn');
    assert.equal(await modeButton.getAttribute('data-tip'), 'Steer · interrupts');
    await modeButton.click();
    const menu = page.locator('.kh-pop.menu');
    await menu.waitFor();
    assert.equal(await menu.locator('.kh-mi').count(), 3);
    assert.deepEqual(await menu.locator('.kh-mi').allTextContents(), ['Steerinterrupts', 'Syncnext turn', 'Asyncon demand']);
    assert.equal(await menu.locator('.kh-mi.on').getAttribute('data-v'), 'steer');
    await menu.locator('.kh-mi[data-v="async"]').click();
    assert.equal(await menu.isHidden(), true);
    assert.equal(await modeButton.getAttribute('data-tip'), 'Async · on demand');
    await page.locator('.kh-rrow:has([data-kh-agent="agent_scout"]) + .kh-mode-status').waitFor({ state: 'hidden' });
    assert.equal(await modeButton.getAttribute('aria-label'), 'Listening mode for Dolan: Async · on demand');
    // Keyboard: Enter opens the menu on the active item, arrows move, Escape returns to the trigger.
    assert.equal(await modeButton.getAttribute('aria-haspopup'), 'menu');
    await modeButton.focus();
    await page.keyboard.press('Enter');
    await menu.locator('[role="menu"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-v')), 'async');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitemradio');
    assert.equal(await menu.locator('[role="menuitemradio"][aria-checked="true"]').getAttribute('data-v'), 'async');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-v')), 'steer', 'ArrowDown wraps to the first item');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-v')), 'sync');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-v')), 'steer');
    await page.keyboard.press('Enter');
    assert.equal(await menu.isHidden(), true);
    assert.equal(await modeButton.evaluate(button => button === document.activeElement), true, 'choosing a mode returns focus to the trigger');
    assert.equal(await modeButton.getAttribute('data-tip'), 'Steer · interrupts');
    await page.locator('.kh-rrow:has([data-kh-agent="agent_scout"]) + .kh-mode-status').waitFor({ state: 'hidden' });
    await page.keyboard.press('Enter');
    await menu.locator('[role="menu"]').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await menu.isHidden(), true);
    assert.equal(await modeButton.evaluate(button => button === document.activeElement), true, 'Escape returns focus to the trigger');
    await page.locator('.kh-back').click();
    assert.equal(await page.title(), 'back');

    if (process.env.KHALA_ROSTER_SCREENSHOT_DIR) {
      const shots = process.env.KHALA_ROSTER_SCREENSHOT_DIR;
      await mkdir(shots, { recursive: true });
      for (const width of [1280, 390]) {
        for (const theme of ['dark', 'light']) {
          const shot = await context.newPage();
          await shot.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await shot.goto(`${url}?crowd&theme=${theme}`);
          await shot.locator('#kh-head-btn').click();
          await shot.waitForTimeout(300);
          await shot.screenshot({ path: join(shots, `roster-${width}-${theme}.png`) });
          if (width === 390) {
            await shot.locator('.kh-mode-btn').first().click();
            await shot.locator('.kh-pop.menu').waitFor();
            await shot.screenshot({ path: join(shots, `mode-menu-${width}-${theme}.png`) });
            await shot.locator('.kh-mode-btn').first().click();
          }
          await shot.getByRole('button', { name: 'Rename Scout' }).first().click();
          await shot.waitForTimeout(300);
          await shot.screenshot({ path: join(shots, `rename-${width}-${theme}.png`) });
          await shot.getByLabel('Name for Scout').fill('two words');
          await shot.screenshot({ path: join(shots, `rename-error-${width}-${theme}.png`) });
          await shot.getByRole('button', { name: 'Close details' }).click();
          await shot.locator('#kh-head-btn').click();
          await shot.getByRole('button', { name: '@Scout' }).click();
          await shot.waitForTimeout(300);
          await shot.screenshot({ path: join(shots, `detail-agent-${width}-${theme}.png`) });
          await shot.locator('.kh-d-owner').click();
          await shot.waitForTimeout(300);
          await shot.screenshot({ path: join(shots, `detail-human-${width}-${theme}.png`) });
          await shot.getByRole('button', { name: 'Close details' }).click();
          await shot.getByRole('button', { name: 'Invite' }).click();
          await shot.waitForTimeout(300);
          await shot.screenshot({ path: join(shots, `pop-invite-${width}-${theme}.png`) });
          await shot.close();
        }
      }
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

test('bottom-row roster overlays escape the scroll fade', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-roster-overlay-dist-'));
  const chromiumProfileRoot = await mkdtemp('/tmp/khala-roster-overlay-profile-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox'], env: { ...process.env, TMPDIR: chromiumProfileRoot } });
    for (const theme of ['light', 'dark']) {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        await page.goto(`${server.resolvedUrls!.local[0]!}?theme=${theme}&crowd`);
        await page.locator('#kh-head-btn').click();
        const scroller = page.locator('.kh-roster-in');
        // Put the viewer's last agent at the bottom, with more content below it.
        await scroller.evaluate(element => {
          const row = element.querySelector('[data-kh-agent="agent_scout_2"]')!.parentElement!;
          const rect = row.getBoundingClientRect();
          (element as HTMLElement).style.maxHeight = `${rect.bottom - element.getBoundingClientRect().top + 2}px`;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await page.waitForTimeout(300);
        assert.notEqual(await scroller.evaluate(element => getComputedStyle(element).maskImage), 'none', 'scroll fade remains');
        const row = page.locator('[data-kh-agent="agent_scout_2"]').locator('..');
        const mode = width === 390 ? row.locator('.kh-mode-btn') : row.locator('[role="radio"][data-v="sync"]');
        await mode.hover();
        const tip = page.getByRole('tooltip');
        await tip.waitFor();
        assert.equal(await tip.textContent(), 'Sync · next turn');
        assert.equal(await tip.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return !element.closest('.kh-roster') && rect.width > 0 && rect.height > 0
            && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        }), true, 'tooltip is visible outside the masked ancestor');
        const shots = process.env.KHALA_SCREENSHOT_DIR;
        if (shots) {
          await mkdir(shots, { recursive: true });
          await page.screenshot({ path: join(shots, `bottom-mode-tooltip-${width}-${theme}.png`) });
        }
        await row.getByRole('button', { name: /Rename/ }).hover();
        assert.equal(await tip.textContent(), 'Rename', 'rename tooltip uses the same overlay');
        // Exercise the compact mode menu at both widths, as in a narrow main pane.
        if (width === 1280) await row.locator('.kh-mode-btn').evaluate(element => { (element as HTMLElement).style.display = 'grid'; });
        for (const value of ['steer', 'async', 'sync']) {
          await row.locator('.kh-mode-btn').click();
          const items = page.getByRole('menuitemradio');
          await page.locator('.kh-pop.menu').waitFor();
          await page.waitForTimeout(200);
          assert.equal(await items.count(), 3);
          for (const item of await items.all()) {
            assert.equal(await item.evaluate(element => {
              const rect = element.getBoundingClientRect();
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return hit === element || element.contains(hit);
            }), true, `each menu item is unobscured at its centre (${theme}, ${width}, ${value}, ${await item.textContent()})`);
          }
          if (shots && value === 'steer') await page.screenshot({ path: join(shots, `bottom-mode-menu-${width}-${theme}.png`) });
          await page.locator(`[role="menuitemradio"][data-v="${value}"]`).click();
          await page.locator('.kh-pop').waitFor({ state: 'hidden' });
        }
        await row.getByRole('button', { name: /Rename/ }).click();
        await page.getByLabel('Name for Scout').waitFor();
        await page.waitForTimeout(300);
        assert.equal(await page.getByLabel('Name for Scout').evaluate(element => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), true, 'rename/detail pane is above the roster');
        // Verify remove-member placement from a fresh roster, independently of detail focus restoration.
        await page.goto(`${server.resolvedUrls!.local[0]!}?theme=${theme}&crowd`);
        await page.locator('#kh-head-btn').click();
        const remove = page.getByRole('button', { name: 'Remove Theo Park', exact: true });
        await scroller.evaluate(element => {
          const row = element.querySelector('[aria-label="Remove Theo Park"]')!.closest('.kh-rrow')!;
          (element as HTMLElement).style.maxHeight = `${row.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 2}px`;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await remove.click();
        const dialog = page.getByRole('dialog', { name: 'Remove Theo Park' });
        await dialog.waitFor();
        await page.waitForTimeout(200);
        for (const button of await dialog.getByRole('button').all()) {
          assert.equal(await button.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
          }), true, 'remove-member popover actions escape the roster fade');
        }
        if (shots) await page.screenshot({ path: join(shots, `bottom-remove-menu-${width}-${theme}.png`) });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

test('a failed copy leaves the link selected for copying by hand', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-channel-dist-'));
  const chromiumProfileRoot = await mkdtemp('/tmp/khala-channel-profile-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox'], env: { ...process.env, TMPDIR: chromiumProfileRoot } });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${server.resolvedUrls!.local[0]!}?copyfail`);
    await page.getByRole('button', { name: 'Invite' }).click();
    await page.locator('.kh-link code', { hasText: 'https://khala.example/c/release' }).waitFor();
    await page.locator('.kh-pop').getByRole('button', { name: 'Copy link' }).click();
    const field = page.getByRole('textbox', { name: 'Channel link' });
    await field.waitFor();
    assert.equal(await field.evaluate(element => document.activeElement === element), true);
    assert.equal(await field.evaluate(element => {
      const input = element as HTMLInputElement;
      return input.selectionStart === 0 && input.selectionEnd === input.value.length;
    }), true);
    assert.equal(await page.locator('.kh-toast.on').count(), 0);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

test('an unconfirmed listening mode reverts after 15 seconds', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-channel-dist-'));
  const chromiumProfileRoot = await mkdtemp('/tmp/khala-channel-profile-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox'], env: { ...process.env, TMPDIR: chromiumProfileRoot } });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.install();
    await page.goto(`${server.resolvedUrls!.local[0]!}?offline`);
    await page.clock.pauseAt(Date.now() + 60_000);
    await page.locator('#kh-head-btn').click();
    const scout = page.locator('.kh-rai[data-kh-agent="agent_scout"]').locator('..');
    await scout.locator('[role="radio"][data-v="async"]').click();
    const status = page.locator('.kh-mode-status');
    await status.filter({ hasText: 'Waiting for Scout to switch…' }).waitFor();
    await page.clock.runFor(14_000);
    assert.equal(await scout.locator('[role="radio"][aria-checked="true"]').getAttribute('data-v'), 'async');
    await page.clock.runFor(1_000);
    await status.filter({ hasText: 'Scout didn\'t confirm. It may be offline.' }).waitFor({ timeout: 2_000 });
    assert.equal(await scout.locator('[role="radio"][aria-checked="true"]').getAttribute('data-v'), 'sync');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

declare global { interface Window { __copied: string[] } }
