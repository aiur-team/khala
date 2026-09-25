import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapUrl, containsLeak, createCanary, leakForms, redact } from '../lib/canary.mjs';
import { openBootstrap } from '../lib/opener-adapter.mjs';
import { prepareHandoff } from '../lib/strategies.mjs';

const canary = createCanary();
const url = bootstrapUrl({ origin: 'http://127.0.0.1:4100', canary, channelId: 'channel-1' });
const forms = leakForms(canary);

test('leak detection covers raw, percent-encoded and base64 forms, and redacts them', () => {
  assert.ok(containsLeak(`xdg-open ${url}`, forms));
  assert.ok(containsLeak(encodeURIComponent(url), forms));
  assert.ok(containsLeak(Buffer.from(canary).toString('base64'), forms));
  assert.ok(!containsLeak('xdg-open /run/user/1000/handoff-x/open.html', forms));
  assert.doesNotMatch(redact(`a ${url} b`, forms), new RegExp(canary));
});

test('argv-url hands the credential-bearing URL to the opener', async () => {
  const handoff = await prepareHandoff('argv-url', { url, parentDir: tmpdir() });
  assert.ok(containsLeak(handoff.argv.join(' '), forms));
});

test('private-file hands only a path; the URL lives in a 0600 file in a 0700 directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'khala-bh-'));
  try {
    const handoff = await prepareHandoff('private-file', { url, parentDir: parent });
    assert.equal(handoff.argv.length, 1);
    assert.ok(!containsLeak(handoff.argv[0], forms));
    const [dir, file] = handoff.privatePaths;
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok((await readFile(file, 'utf8')).includes(JSON.stringify(url)));
    await handoff.cleanup();
    await assert.rejects(stat(dir), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

const proven = {
  os: 'linux',
  procfsHidepid: 'off',
  opener: { implementation: 'xdg-utils xdg-open', version: '1.2.1', mode: 'generic' },
  handler: { mimeType: 'text/html', exec: '/usr/bin/chromium --headless=new --user-data-dir=<PRIVATE_BROWSER_PROFILE> %U' },
  browser: { name: 'chromium', major: '150' },
  handoff: 'private-file',
};
const matrix = [{ id: 'p', status: 'proven', profile: proven }];

function fakeSpawn(calls, { fail } = {}) {
  return (command, argv, options) => {
    calls.push({ command, argv, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => (fail ? child.emit('error', Object.assign(new Error(fail), { code: fail })) : child.emit('spawn')));
    return child;
  };
}

async function open(overrides) {
  const parent = await mkdtemp(join(tmpdir(), 'khala-bh-'));
  const calls = [];
  const result = await openBootstrap({
    bootstrapUrl: url,
    credential: canary,
    runtimeProfile: proven,
    matrix,
    handoffParent: parent,
    env: { PATH: '/usr/bin', BROWSER: 'firefox', XDG_CURRENT_DESKTOP: 'Hyprland' },
    spawn: fakeSpawn(calls),
    ...overrides(calls),
  });
  return { result, calls, parent };
}

test('adapter opens a matching profile through xdg-open with a path and a scrubbed environment', async () => {
  const { result, calls, parent } = await open(() => ({}));
  try {
    assert.equal(result.opened, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'xdg-open');
    assert.ok(!containsLeak(JSON.stringify([calls[0].argv, calls[0].options.env]), forms));
    assert.equal(calls[0].options.env.XDG_CURRENT_DESKTOP, 'X-Generic');
    assert.equal(calls[0].options.env.BROWSER, undefined);
    await result.cleanup();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('adapter keeps automatic opening off when the profile is unknown or differs', async () => {
  for (const runtimeProfile of [null, { ...proven, browser: { name: 'chromium', major: '151' } }, { ...proven, procfsHidepid: undefined }]) {
    const { result, calls, parent } = await open(() => ({ runtimeProfile }));
    await rm(parent, { recursive: true, force: true });
    assert.equal(result.opened, false);
    assert.equal(calls.length, 0);
  }
});

test('adapter refuses when the credential would reach the opener environment', async () => {
  const { result, calls, parent } = await open(() => ({ env: { PATH: '/usr/bin', KHALA_URL: url } }));
  await rm(parent, { recursive: true, force: true });
  assert.deepEqual([result.opened, calls.length], [false, 0]);
  assert.match(result.reason, /argv or environment/);
});

test('adapter reports a missing opener without throwing and removes the handoff file', async () => {
  const { result, parent } = await open(calls => ({ spawn: fakeSpawn(calls, { fail: 'ENOENT' }) }));
  try {
    assert.equal(result.opened, false);
    assert.match(result.reason, /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
