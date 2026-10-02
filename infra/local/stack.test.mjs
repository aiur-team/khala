import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertPortFree, buildEnv, collectStatus, ensureObserver, loadOrCreateState, parseArgs } from './stack.mjs';

test('state persists secrets, users and ports with private modes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'khala-local-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  let port = 30000;
  const deps = { randomHex: () => String(++calls).padStart(64, '0'), availablePort: async () => ++port,
    assertPortFree: async () => {}, bcrypt: async () => '$2b$10$' + 'a'.repeat(53) };
  const first = await loadOrCreateState(dir, deps);
  const count = calls;
  const second = await loadOrCreateState(dir, deps);
  assert.deepEqual(first, second);
  assert.equal(calls, count);
  assert.equal(first.ports.gateway, 8443);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, 'state.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')), first);
});

test('gateway port falls back only at creation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'khala-local-port-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let port = 31000;
  const state = await loadOrCreateState(dir, { randomHex: () => 'a'.repeat(64),
    availablePort: async () => ++port, bcrypt: async () => 'hash',
    assertPortFree: async () => { throw new Error('busy'); } });
  assert.equal(state.ports.gateway, 31001);
  assert.equal(new Set(Object.values(state.ports)).size, 4);
});

test('port conflict names service and port', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(assertPortFree(port, 'gateway'), new RegExp(`gateway.*${port}`));
});

test('failed probes report a stopped stack without throwing', async () => {
  const probes = Object.fromEntries(['synapse', 'postgres', 'dex', 'netlify', 'gateway'].map(name =>
    [name, async () => { throw new Error('offline'); }]));
  const state = { ports: { gateway: 8443 }, users: [{ email: 'a@khala.local', password: 'secret', bcrypt: 'private' }], pids: { netlify: 99999999 } };
  const status = await collectStatus(state, probes);
  assert.ok(Object.values(status.services).every(value => value === 'down'));
  assert.deepEqual(status.users, [{ email: 'a@khala.local', password: 'secret' }]);
  assert.equal(status.dex, 'https://127.0.0.1:8443/dex');
});

test('missing state needs no probes', async () => {
  const result = await collectStatus(null, {});
  assert.deepEqual(result.users, []);
  assert.ok(Object.values(result.services).every(value => value === 'down'));
});

test('arguments allow only supported commands and services', () => {
  assert.deepEqual(parseArgs(['down', '--wipe']), { command: 'down', wipe: true });
  assert.deepEqual(parseArgs(['logs', 'netlify']), { command: 'logs', wipe: false, service: 'netlify' });
  assert.throws(() => parseArgs(['bogus']), /unknown_command:bogus/);
  for (const args of [['up', '--wipe'], ['logs', 'bad'], ['status', 'extra'], []]) assert.throws(() => parseArgs(args));
});

test('child env uses stable namespaces without inherited fixture credentials', () => {
  const state = { ports: { gateway: 8443, dex: 30001 }, serverName: 'khala.local',
    secrets: { dbPassword: 'db', registrationSharedSecret: 'reg', oidcClientSecret: 'oidc', passwordDerivationSecret: 'derive', invitationHmacSecret: 'invite' },
    users: [{ email: 'a@khala.local', bcrypt: 'hashA', id: 'A' }, { email: 'b@khala.local', bcrypt: 'hashB', id: 'B' }] };
  const env = buildEnv(state, '/private/.khala-local', { PATH: '/bin', KHALA_E2E_LIVE: '1', KHALA_LOCAL_AUTH: 'enabled' });
  assert.equal(env.KHALA_STATE_NAMESPACE, 'khala-local-preview');
  assert.equal(env.PUBLIC_APP_ORIGIN, 'https://127.0.0.1:8443');
  assert.ok(!Object.keys(env).some(key => key.startsWith('KHALA_E2E_')));
  assert.equal(env.KHALA_LOCAL_AUTH, undefined);
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'NETLIFY_HOME', 'CODEX_HOME']) {
    assert.ok(env[key].startsWith('/private/.khala-local/home'));
  }
});

test('detached child survives the launching CLI and writes raw logs', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = await mkdtemp(path.join(tmpdir(), 'khala-local-child-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'child.log');
  const moduleUrl = new URL('./stack.mjs', import.meta.url).href;
  const source = `import { detachedChild } from ${JSON.stringify(moduleUrl)};
    const child = await detachedChild(process.execPath, ['-e', 'console.log("raw child output"); setInterval(() => {}, 1000)'], process.env, ${JSON.stringify(log)});
    console.log(child.pid);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 5000 });
  const pid = Number(stdout.trim());
  t.after(() => { try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ } });
  process.kill(pid, 0);
  for (let attempts = 0; attempts < 30; attempts++) {
    if ((await readFile(log, 'utf8')).includes('raw child output')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(await readFile(log, 'utf8'), /raw child output/);
  assert.equal((await stat(log)).mode & 0o777, 0o600);
});

test('observer startup recovers registration followed by a failed login', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'khala-local-observer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let registrations = 0;
  let loginAttempts = 0;
  let passwordCalls = 0;
  const password = 'persisted-observer-password';
  const state = { secrets: { registrationSharedSecret: 'registration-secret' } };
  const deps = {
    randomHex: () => { passwordCalls++; return password; },
    fetch: async (url, options) => {
      if (url.endsWith('/login')) {
        assert.equal(JSON.parse(options.body).password, password);
        loginAttempts++;
        if (loginAttempts === 1) return new Response('{}', { status: 403 });
        if (loginAttempts === 2) throw new Error('connection_lost_after_registration');
        return Response.json({ user_id: '@observer:khala.local', access_token: 'observer-token' });
      }
      if (!options) return Response.json({ nonce: 'nonce' });
      // The credential must survive an interrupted CLI before registration.
      const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
      assert.equal(saved.observerPassword, password);
      assert.equal(JSON.parse(options.body).password, password);
      registrations++;
      return Response.json({});
    },
  };
  await assert.rejects(ensureObserver('http://127.0.0.1:8008', state, dir, deps), /connection_lost/);
  const resumed = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(resumed.observer, undefined);
  const observer = await ensureObserver('http://127.0.0.1:8008', resumed, dir, deps);
  assert.deepEqual(observer, { userId: '@observer:khala.local', accessToken: 'observer-token' });
  assert.equal(registrations, 1);
  assert.equal(passwordCalls, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).observer, observer);
  await ensureObserver('http://127.0.0.1:8008', resumed, dir, deps);
  assert.equal(loginAttempts, 3);
});

test('observer login outages do not attempt duplicate registration', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'khala-local-observer-outage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { secrets: { registrationSharedSecret: 'registration-secret' }, observerPassword: 'saved' };
  let calls = 0;
  await assert.rejects(ensureObserver('http://127.0.0.1:8008', state, dir, {
    fetch: async url => { calls++; assert.ok(url.endsWith('/login')); return new Response('{}', { status: 503 }); },
  }), /observer_login_failed/);
  assert.equal(calls, 1);
});

test('Netlify base follows directory-only Git root detection in worktrees', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { netlifyBase } = await import('./stack.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'khala-local-worktree-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, '.git'));
  const worktree = path.join(dir, 'worktrees', 'ticket');
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, '.git'), 'gitdir: ../../.git/worktrees/ticket');
  assert.equal(await netlifyBase(worktree), path.join('worktrees', 'ticket', '.khala-local', 'netlify'));
  assert.equal(await netlifyBase(dir), path.join('.khala-local', 'netlify'));
});
