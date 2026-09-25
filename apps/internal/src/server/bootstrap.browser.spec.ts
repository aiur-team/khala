import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { startChannelServer } from './channel-server';
import { channelId, createChannelFixture } from './fixtures/channel-fixture';
import type { LogEvent, LoopbackServer } from './server';

test('AE2: the external bootstrap script exchanges a fragment credential under the strict CSP', { timeout: 90_000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-bootstrap-'));
  // Chromium's singleton socket has a strict path-length cap; keep its profile short.
  const chromiumProfileRoot = fs.mkdtempSync('/tmp/khala-bootstrap-profile-');
  const bundle = path.join(base, 'bundle');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'index.html'), [
    '<!doctype html><html><head><meta charset="utf-8"><script src="/app.js"></script></head>',
    '<body><script>window.inlineRan = true;</script></body></html>',
  ].join(''));
  // Stand-in for the later local web bundle: reads the request secret and calls the API.
  fs.writeFileSync(path.join(bundle, 'app.js'), `
    const id = decodeURIComponent(location.pathname.split('/')[2]);
    const secret = sessionStorage.getItem('khala.requestSecret');
    window.withSecret = fetch('/api/v1/channels/' + id, { headers: { 'x-khala-request-secret': secret } }).then(r => r.status);
    window.withoutSecret = fetch('/api/v1/channels/' + id).then(r => r.status);
  `);
  fs.mkdirSync(path.join(base, 'store'));
  const fixture = createChannelFixture({ root: path.join(base, 'store'), now: Date.now() });
  const events: LogEvent[] = [];
  let server: LoopbackServer | undefined;
  let hostile: Server | undefined;
  let browser: Browser | undefined;
  try {
    server = await startChannelServer({
      store: fixture.store,
      bootstrap: [fixture.bootstrap],
      bindings: [],
      newId: () => 'unused',
      clock: Date.now,
      log: event => events.push(event),
      startPort: 0,
      assets: {
        root: bundle,
        entries: [
          { route: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' },
          { route: '/app.js', file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
        ],
        channelDocument: '/',
      },
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', entry => {
      if (/Content Security Policy/i.test(entry.text())) violations.push(entry.text());
    });

    const credential = fixture.bootstrap.credential;
    await page.goto(`${server.origin}/__khala/bootstrap#credential=${credential}&channel=${channelId}`);
    await page.waitForURL(`${server.origin}/channels/${channelId}`);

    assert.equal(page.url(), `${server.origin}/channels/${channelId}`);
    assert.equal(await page.evaluate('location.hash'), '');
    assert.equal(await page.evaluate('window.withSecret'), 200, 'cookie plus request secret authorizes the API');
    assert.equal(await page.evaluate('window.withoutSecret'), 401, 'the cookie alone is not a credential');
    assert.equal(await page.evaluate('document.cookie'), '', 'the session cookie is HttpOnly');
    assert.equal(await page.evaluate('window.inlineRan'), undefined, 'inline script is blocked by CSP');
    assert.ok(violations.length > 0, 'the inline script produced a CSP violation');

    const cookies = await context.cookies();
    assert.equal(cookies.length, 1);
    assert.deepEqual(
      { name: cookies[0]!.name, domain: cookies[0]!.domain, path: cookies[0]!.path, httpOnly: cookies[0]!.httpOnly, sameSite: cookies[0]!.sameSite },
      { name: 'khala_session', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
    );
    assert.notEqual(cookies[0]!.value, credential);

    // location.replace removed the bootstrap entry, so no history entry carries the fragment.
    await page.goBack();
    assert.ok(!page.url().includes(credential), 'the fragment credential is absent from history');

    // Another loopback port shares the cookie jar (cookies ignore ports) but cannot use it.
    hostile = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>other port</title>');
    });
    await new Promise<void>(resolve => hostile!.listen(0, '127.0.0.1', resolve));
    const hostilePort = (hostile.address() as { port: number }).port;
    const before = events.length;
    await page.goto(`http://127.0.0.1:${hostilePort}/`);
    await page.evaluate(async target => {
      for (const init of [{ credentials: 'include', mode: 'no-cors' }, { credentials: 'include', method: 'POST', mode: 'no-cors', body: '{}' }] as const) {
        await fetch(target, init).catch(() => undefined);
      }
    }, `${server.origin}/api/v1/channels/${channelId}`);
    const attempts = events.slice(before).filter(event => event.type === 'request');
    assert.ok(attempts.length >= 1, 'the cross-port requests reached the server');
    assert.ok(attempts.every(event => event.type === 'request' && event.status >= 400), 'no cross-port request was authorized');

    const logged = JSON.stringify(events);
    assert.ok(!logged.includes(credential) && !logged.includes(cookies[0]!.value), 'logs carry no credential');
  } finally {
    await browser?.close();
    await server?.close();
    await new Promise(resolve => (hostile ? hostile.close(resolve) : resolve(undefined)));
    fixture.handle.close();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(chromiumProfileRoot, { recursive: true, force: true });
  }
});
