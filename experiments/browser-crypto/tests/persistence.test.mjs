import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { preview } from 'vite';

test('real Chromium IndexedDB survives full process restart; missing store and second writer fail explicitly', async () => {
  await mkdir('profiles', {recursive:true});
  const profile = await mkdtemp('profiles/disposable-');
  const browserTemp = await mkdtemp(`${homedir()}/.cache/khala-proof-`);
  const server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
  const url = server.resolvedUrls.local[0];
  let context;
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { env: {...process.env, TMPDIR: browserTemp}, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await context.newPage();
    await page.goto(url); await page.waitForFunction(() => !!window.openDevice);
    return page;
  };
  try {
    let page = await launch();
    const processInfo = await (await context.browser().newBrowserCDPSession()).send('SystemInfo.getProcessInfo');
    const firstPid = processInfo.processInfo.find(p => p.type === 'browser').id;
    const first = await page.evaluate(async () => { window.device = await window.openDevice(); return window.device.client.getCrypto().getOwnDeviceKeys(); });
    const follower = await context.newPage(); await follower.goto(url); await follower.waitForFunction(() => !!window.openDevice);
    assert.match(await follower.evaluate(async () => { try { await window.openDevice(); } catch (e) { return e.message; } }), /already has a writer/);
    await context.close();
    page = await launch();
    const secondInfo = await (await context.browser().newBrowserCDPSession()).send('SystemInfo.getProcessInfo');
    assert.notEqual(secondInfo.processInfo.find(p => p.type === 'browser').id, firstPid);
    const second = await page.evaluate(async () => { window.device = await window.openDevice(); return window.device.client.getCrypto().getOwnDeviceKeys(); });
    assert.deepEqual(second, first);
    await context.close();
    page = await launch();
    await page.evaluate(async () => { for (const db of await indexedDB.databases()) await new Promise((resolve,reject) => { const req=indexedDB.deleteDatabase(db.name); req.onsuccess=resolve;req.onerror=reject;req.onblocked=()=>reject(new Error('blocked')); }); });
    assert.match(await page.evaluate(async () => { try { await window.openDevice(); } catch(e) { return e.message; } }), /crypto store lost/);
  } finally { await context?.close(); await new Promise(resolve => server.httpServer.close(resolve)); await rm(profile, { recursive: true, force: true }); await rm(browserTemp,{recursive:true,force:true}); }
});
