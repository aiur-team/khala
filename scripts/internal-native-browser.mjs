#!/usr/bin/env node
// Browser-only controls for the private CDP profile created by the native canary.
// Messages arrive on stdin and are never written to argv, stdout, or a file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const [directory, action, name] = process.argv.slice(2);
const fail = stage => { throw Object.assign(new Error(stage), { stage }); };
async function main() {
  if (!directory || !path.isAbsolute(directory)) fail('run_directory');
  const run = JSON.parse(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'));
  if (!run.browserPort || !run.channelId) fail('browser_not_ready');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${run.browserPort}`);
  try {
    const context = browser.contexts()[0];
    const page = context.pages().find(item => item.url().startsWith(run.origin)) ?? context.pages()[0];
    if (!page) fail('browser_page');
    let blocked = 0;
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === run.origin) return route.continue();
      blocked++;
      return route.abort();
    });
    const channel = `${run.origin}/channels/${run.channelId}`;
    if (action === 'approve') {
      if (!['codex', 'claude'].includes(name)) fail('approval_harness');
      const rawSession = run.sessions?.[name];
      const expected = rawSession && createHash('sha256').update(['khala.internal.session.v1', name, rawSession].join('\0')).digest('base64url');
      if (!expected) fail('approval_session');
      await page.goto(channel);
      await page.getByRole('link', { name: /^Channel requests, \d+ pending$/ }).click();
      const rows = page.getByRole('list', { name: 'Requests waiting for you' }).locator('.channel-requests__row');
      const row = rows.filter({ hasText: expected });
      if (await row.count() !== 1) fail('approval_exact_session');
      await row.getByRole('button', { name: 'Review request' }).click();
      const dialog = page.getByRole('dialog', { name: /Let this agent session join/ });
      await dialog.getByRole('button', { name: 'Approve access' }).click();
      await dialog.locator('.decision-dialog__status').getByText(/^Approved\./).waitFor();
    } else if (action === 'send') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8').trim();
      if (!body || Buffer.byteLength(body) > 4_000) fail('message_input');
      await page.goto(channel);
      await page.getByRole('textbox', { name: 'Message' }).fill(body);
      await page.getByRole('button', { name: 'Send message' }).click();
      await page.getByText(body, { exact: true }).waitFor();
    } else if (action === 'reload') {
      await page.goto(channel);
      await page.reload();
      await page.getByRole('heading', { name: 'Channel', level: 1 }).waitFor();
    } else if (action === 'contains') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8').trim();
      if (!body) fail('expected_text');
      await page.goto(channel);
      await page.reload();
      await page.getByText(body, { exact: true }).waitFor({ timeout: 15_000 });
      const proof = createHash('sha256').update(body).digest('hex');
      run.browserProofs = [...new Set([...(run.browserProofs ?? []), proof])];
      fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
    } else fail('action');
    process.stdout.write(JSON.stringify({ ok: true, action, runId: run.id, blockedExternalRequests: blocked }) + '\n');
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, kind: 'unproven', stage: error.stage ?? error.message }) + '\n');
  process.exitCode = 1;
});
