import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createAgentMatrixSession } from './session';
import type { AgentMatrixSession, SessionMessage } from './session';
import { readStack, registrationSecret, registerUser, login, repoRoot } from '../../fixtures/live/stack';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type {} from '../../fixtures/browser-human/human';

const device = () => `KH_AGENT_${randomBytes(4).toString('hex')}`;
async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do { value = await read(); if (accepts(value)) return value; await delay(250); } while (Date.now() < deadline);
  return value;
}
type Result = { scenario: number; expected: string; observed: unknown; outcome: 'pass' | 'finding' };
const results: { date: string; commit: string; versions: Record<string, string>; logs: string[]; timings: Record<string, number>; scenarios: Result[]; error?: string } = {
  date: new Date().toISOString(), commit: execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  versions: { node: process.version, sdk: '42.4.0' }, logs: [], timings: {}, scenarios: [],
};
const record = (scenario: number, expected: string, observed: unknown, pass: boolean) => results.scenarios.push({ scenario, expected, observed, outcome: pass ? 'pass' : 'finding' });
const sessions: AgentMatrixSession[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser;
let server: Server;
let output: string;
let browserTmp: string;
let origin: string;
let h1: Page;
let a1: AgentMatrixSession;
let a1User: { userId: string; password: string };
let room: string;
const received: SessionMessage[] = [];

async function human(prefix: string) {
  const user = await registerUser(prefix);
  const creds = await login(user.userId, user.password, `HUMAN_${randomBytes(4).toString('hex')}`);
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); contexts.push(context);
  const page = await context.newPage(); await page.goto(origin);
  await page.waitForFunction(() => !!window.human);
  await page.evaluate(creds => window.human.open(creds), creds);
  return { page, creds };
}
async function agent(creds: AgentCredentials, logs = results.logs) {
  const session = await createAgentMatrixSession(creds, { log: line => logs.push(line) }); sessions.push(session); return session;
}

describe.skipIf(process.env.KHALA_E2E_LIVE !== '1')('Node rust crypto against local stack', () => {
  beforeAll(async () => {
    try {
      readStack(); registrationSecret();
      output = await mkdtemp(path.join(tmpdir(), 'km110-browser-'));
      await build({ root: path.join(repoRoot, 'packages/agent/fixtures/browser-human'), configFile: false, logLevel: 'error', build: { outDir: output, emptyOutDir: true } });
      server = createServer(async (req, res) => {
        try {
          const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
          const file = path.resolve(output, `.${pathname === '/' ? '/index.html' : pathname}`);
          if (!file.startsWith(`${output}${path.sep}`)) { res.writeHead(403).end(); return; }
          res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'text/html');
          res.end(await readFile(file));
        } catch { res.writeHead(404).end(); }
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
      origin = `http://127.0.0.1:${address.port}`;
      browserTmp = await mkdtemp('/tmp/km110-833-chromium-');
      browser = await chromium.launch({ env: { ...process.env, TMPDIR: browserTmp, XDG_CONFIG_HOME: path.join(output, 'config') }, executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
      results.versions.chromium = browser.version();
      const versions = await fetch(`${readStack().homeserver}/_synapse/admin/v1/server_version`).then(r => r.json());
      results.versions.synapse = versions.server_version;
    } catch (error) { results.error = error instanceof Error ? error.message : 'setup_failed'; throw error; }
  }, 180_000);
  afterEach(({ task }) => {
    const errors = task.result?.errors;
    if (errors?.length) results.error = errors.map(error => error.message).join('; ');
  });
  afterAll(async () => {
    await Promise.all(sessions.map(s => s.stop()));
    await Promise.all(contexts.map(c => c.close()));
    await browser?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (output) await rm(output, { recursive: true, force: true });
    if (browserTmp) await rm(browserTmp, { recursive: true, force: true });
    await mkdir(path.join(repoRoot, '.khala-local/results'), { recursive: true });
    await writeFile(path.join(repoRoot, '.khala-local/results/m1-node-matrix-agent.json'), JSON.stringify(results, null, 2));
  });

  it('10: imports the three pre-invite messages (AE1)', async () => {
    const h = await human('h1'); h1 = h.page;
    await h1.evaluate(() => window.human.crossSign());
    room = await h1.evaluate(() => window.human.createSharedRoom());
    for (const body of ['one', 'two', 'three']) await h1.evaluate(({ room, body }) => window.human.send(room, body), { room, body });
    a1User = await registerUser('a1'); const creds = await login(a1User.userId, a1User.password, device());
    const started = Date.now(); a1 = await agent(creds); results.timings.sessionReadyMs = Date.now() - started;
    a1.onMessage(m => received.push(m));
    const invited = Date.now(); await h1.evaluate(({ room, userId }) => window.human.invite(room, userId), { room, userId: a1.userId });
    await a1.waitForInvite(room, 60_000); await a1.join(room);
    const history = await eventually(() => a1.history(room, 30), page => ['one', 'two', 'three'].every(body => page.messages.some(m => m.body === body)), 15_000);
    results.timings.inviteToFirstDecryptMs = Date.now() - invited;
    results.timings.createToFirstDecryptMs = Date.now() - started;
    results.versions.crypto = results.logs.find(line => line.startsWith('crypto_version='))?.slice(15) ?? 'unknown';
    const bodies = history.messages.map(m => m.body);
    const boundary = history.messages.find(m => m.body === 'three')?.eventId;
    const older = boundary ? await a1.history(room, 30, boundary) : { messages: [] };
    const beforeBodies = older.messages.map(m => m.body);
    const pass = beforeBodies.join(',') === 'one,two' && ['one', 'two', 'three'].every(body => bodies.includes(body));
    record(10, 'one, two, three decrypted via MSC4268', { bodies, beforeBodies, logs: [...results.logs] }, pass);
    // A settled-decision failure stops the spike, while leaving recorded evidence.
    expect(pass, 'AE1 failed; stop and report without widening scope').toBe(true);
  }, 180_000);

  it('11–13: sends, excludes self and pre-join events, receives live text', async () => {
    if (!a1 || results.scenarios[0]?.outcome !== 'pass') throw new Error('AE1_failed: stop spike');
    await a1.send(room, 'agent-hello');
    const browserMessages = await eventually(() => h1.evaluate(room => window.human.readBodies(room), room), messages => messages.some(m => m.body === 'agent-hello' && m.sender === a1.userId));
    record(11, 'H1 decrypts agent-hello within 20 s', browserMessages, browserMessages.some(m => m.body === 'agent-hello' && m.sender === a1.userId));
    const history = await eventually(() => a1.history(room, 30), page => page.messages.some(m => m.body === 'agent-hello'));
    await h1.evaluate(room => window.human.send(room, 'four'), room);
    await eventually(async () => received, messages => messages.some(m => m.body === 'four'));
    record(12, 'self excluded from live but included in history', { live: received.map(m => m.body), history: history.messages.map(m => m.body) }, !received.some(m => m.body === 'agent-hello') && history.messages.some(m => m.body === 'agent-hello'));
    record(13, 'four live from H1; pre-join absent; displayName Maya', { live: received, displayName: a1.displayName((browserMessages.find(m => m.sender !== a1.userId)?.sender) ?? '') }, received.some(m => m.body === 'four' && m.sender !== a1.userId) && !received.some(m => ['one', 'two', 'three'].includes(m.body)) && a1.displayName(browserMessages.find(m => m.sender !== a1.userId)?.sender ?? '') === 'Maya');
    expect(results.scenarios.filter(scenario => [11, 12, 13].includes(scenario.scenario)).every(scenario => scenario.outcome === 'pass')).toBe(true);
  }, 180_000);

  it('14: records behavior without inviter cross-signing', async () => {
    if (results.scenarios[0]?.outcome !== 'pass') throw new Error('AE1_failed: stop spike');
    const h2 = await human('h2'); const r2 = await h2.page.evaluate(() => window.human.createSharedRoom());
    await h2.page.evaluate(room => window.human.send(room, 'pre'), r2);
    const user = await registerUser('a2'); const logs: string[] = [];
    const a2 = await agent(await login(user.userId, user.password, device()), logs); const messages: SessionMessage[] = []; a2.onMessage(m => messages.push(m));
    await h2.page.evaluate(({ room, userId }) => window.human.invite(room, userId), { room: r2, userId: a2.userId });
    await a2.waitForInvite(r2, 60_000); await a2.join(r2);
    const history = await a2.history(r2, 30);
    await h2.page.evaluate(room => window.human.send(room, 'post'), r2);
    await eventually(async () => messages, ms => ms.some(m => m.body === 'post'));
    record(14, 'pre undecryptable; post live decrypted; no crash', { history, live: messages, logs }, !history.messages.some(m => m.body === 'pre') && logs.some(line => /^history_undecryptable=[1-9]/.test(line)) && messages.some(m => m.body === 'post'));
  }, 180_000);

  it('15: records restart with an existing identity and fresh device', async () => {
    if (results.scenarios[0]?.outcome !== 'pass') throw new Error('AE1_failed: stop spike');
    await a1.stop(); const logs: string[] = [];
    const restarted = await agent(await login(a1User.userId, a1User.password, device()), logs);
    const messages: SessionMessage[] = []; restarted.onMessage(m => messages.push(m)); await restarted.join(room);
    await h1.evaluate(room => window.human.send(room, 'five'), room);
    await eventually(async () => messages, ms => ms.some(m => m.body === 'five'));
    const history = await restarted.history(room, 30);
    record(15, 'existing identity unavailable; five decrypts live; history observed without throw', { logs, live: messages, history }, logs.includes('cross_signing=unavailable_existing_identity') && messages.some(m => m.body === 'five'));
  }, 180_000);
});
