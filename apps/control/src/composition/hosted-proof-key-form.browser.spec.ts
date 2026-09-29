import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { OWNER_FORM_HEADERS } from './hosted-proof-key-authority';

test('owner form POST carries the exact Origin without leaking its candidate URL', async () => {
  let received: { origin: string | undefined; referer: string | undefined } | null = null;
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      received = { origin: request.headers.origin, referer: request.headers.referer };
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('approved');
      return;
    }
    response.writeHead(200, {
      ...OWNER_FORM_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end('<form method="post" action="/approve"><button type="submit">Approve key</button></form>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/approve?candidate=private-capability`);
    await page.getByRole('button', { name: 'Approve key' }).click();
    await assert.doesNotReject(page.getByText('approved').waitFor());
    assert.deepEqual(received, { origin, referer: `${origin}/` });
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
