// Black-box quickstart: the packed CLI, local server, and owner browser UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { installTarball, packedTarball, removeScratch } from '../agent-setup/harness.mjs';

function command(bin, env, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

function success(result) {
  assert.equal(result.code, 0, result.err || result.out);
  return result;
}

function refusalCode(result) {
  assert.notEqual(result.code, 0, JSON.stringify(result));
  // Node 22 can also write its experimental SQLite warning to stderr.
  const codes = [result.out, result.err]
    .flatMap(output => output.split('\n'))
    .filter(line => line.startsWith('{'))
    .map(line => {
      const body = JSON.parse(line);
      return body.code ?? body.error;
    })
    .filter(Boolean);
  assert.deepEqual(codes, ['not_connected'], JSON.stringify(result));
  return codes[0];
}

function readBodies(result) {
  success(result);
  return [...result.out.matchAll(/^canonicalReleaseJson:\n(.+)$/gm)]
    .flatMap(([, json]) => JSON.parse(json)[5].map(item => item.at(-1)));
}

test('packaged local quickstart connects two exact sessions with owner approval', { timeout: 300_000 }, async () => {
  // Chromium's singleton socket has a short path limit; the workspace TMPDIR is too deep.
  const temp = fs.mkdtempSync('/tmp/khala-525-smoke-');
  const state = path.join(temp, 'state');
  fs.mkdirSync(state, { mode: 0o700 });
  let browser;
  let launcher;
  let packageCleanup = () => {};
  try {
    const packed = packedTarball();
    packageCleanup = packed.cleanup;
    const { bin } = installTarball(packed.tarball);
    const env = { HOME: temp, XDG_STATE_HOME: state, PATH: '/usr/bin:/bin', TMPDIR: temp };
    launcher = spawn(process.execPath, [bin, 'internal'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let launchError = '';
    launcher.stderr.setEncoding('utf8').on('data', chunk => { launchError += chunk; });
    const report = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`launcher timed out: ${launchError}`)), 60_000);
      launcher.stdout.setEncoding('utf8').on('data', chunk => {
        output += chunk;
        const line = output.split('\n').find(entry => entry.includes('"kind":"running"'));
        if (line) { clearTimeout(timeout); resolve(JSON.parse(line)); }
      });
      launcher.once('close', code => { clearTimeout(timeout); reject(new Error(`launcher exited ${code}: ${launchError}`)); });
      launcher.once('error', reject);
    });
    const channelUrl = `${report.origin}/channels/${report.channelId}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], env: { ...process.env, HOME: temp, TMPDIR: temp } });
    const page = await browser.newPage();
    const externalRequests = [];
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === report.origin) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.goto(report.url);
    await page.getByRole('heading', { name: 'Local channel' }).waitFor();

    async function discover(harness, session, label) {
      const result = success(await command(bin, env, ['internal', 'discovery', '--harness', harness, '--session', session, '--label', label]));
      return JSON.parse(result.out).descriptorPath;
    }
    const ada = await discover('codex', 'smoke-ada-session', 'Ada');
    const bea = await discover('claude', 'smoke-bea-session', 'Bea');
    assert.notEqual(ada, bea);
    const join = descriptor => command(bin, env, ['--internal-descriptor', descriptor, 'join', channelUrl]);
    assert.equal(JSON.parse((await join(ada)).out).outcome, 'pending_owner');
    assert.equal(JSON.parse((await join(bea)).out).outcome, 'pending_owner');

    // Discovery and an access request cannot admit either session by themselves.
    const adaGrant = path.join(path.dirname(ada), 'grant.json');
    const beaGrant = path.join(path.dirname(bea), 'grant.json');
    assert.equal(fs.existsSync(adaGrant), false);
    assert.equal(fs.existsSync(beaGrant), false);
    for (const descriptor of [ada, bea]) {
      const refusedSend = await command(bin, env, ['--internal-descriptor', descriptor, 'send'], 'before approval');
      assert.equal(refusalCode(refusedSend), 'not_connected');
      const refusedRead = await command(bin, env, ['--internal-descriptor', descriptor, 'read']);
      assert.equal(refusalCode(refusedRead), 'not_connected');
    }
    for (const name of ['Ada', 'Bea']) {
      await page.getByRole('link', { name: /Channel requests/ }).click();
      const row = page.getByRole('list', { name: 'Requests waiting for you' }).locator('.channel-requests__row', { hasText: name });
      await row.getByRole('button', { name: 'Review request' }).click();
      const dialog = page.getByRole('dialog', { name: /Let this agent session join/ });
      await dialog.getByRole('button', { name: 'Approve access' }).click();
      await dialog.locator('.decision-dialog__status').getByText(/^Approved\./).waitFor();
      await page.keyboard.press('Escape');
    }
    assert.equal(JSON.parse(success(await join(ada)).out).outcome, 'connected');
    assert.equal(JSON.parse(success(await join(bea)).out).outcome, 'connected');
    const send = (grant, message) => command(bin, env, ['--internal-descriptor', grant, 'send'], message);
    const read = grant => command(bin, env, ['--internal-descriptor', grant, 'read']);
    success(await send(adaGrant, 'Ada: hello Bea'));
    const beaRead = await read(beaGrant);
    assert.deepEqual(readBodies(beaRead), ['Ada: hello Bea']);
    const beaToken = /batchToken: (\S+)/.exec(beaRead.out)?.[1];
    assert.ok(beaToken);
    success(await command(bin, env, ['--internal-descriptor', beaGrant, 'read', '--ack', beaToken]));
    success(await send(beaGrant, 'Bea: hello Ada'));
    const adaRead = await read(adaGrant);
    assert.deepEqual(readBodies(adaRead), ['Bea: hello Ada']);
    const adaToken = /batchToken: (\S+)/.exec(adaRead.out)?.[1];
    assert.ok(adaToken);
    success(await command(bin, env, ['--internal-descriptor', adaGrant, 'read', '--ack', adaToken]));
    await page.goto(channelUrl);
    await page.getByText('Bea: hello Ada').waitFor();
    assert.match(await page.locator('body').innerText(), /Ada: hello Bea/);
    assert.deepEqual(externalRequests, [], 'the browser flow must need only localhost');
  } finally {
    await browser?.close();
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      await new Promise(resolve => {
        launcher.once('close', resolve);
        launcher.kill('SIGTERM');
      });
    }
    packageCleanup();
    removeScratch();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
