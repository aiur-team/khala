// KM-151: pure-function tests for the acceptance browser driver (no browser).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  DriverError, createBidiMatcher, isLoopbackOrigin, isMarkerCandidate, newTabToken, parseArgs, parseChannelLine,
  planSignin, resolveOrigin, selectDexUser,
} from './humans.mjs';

const script = fileURLToPath(new URL('./humans.mjs', import.meta.url));

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DriverError, `expected DriverError, got ${error}`);
    return error.code;
  }
  assert.fail('expected a DriverError');
}

const STATUS = Object.freeze({
  origin: 'https://127.0.0.1:8443',
  homeserver: 'https://127.0.0.1:8443',
  dex: 'https://127.0.0.1:8443/dex',
  users: [{ email: 'alice@khala.local', password: 'pw-a' }, { email: 'bob@khala.local', password: 'pw-b' }],
  services: { synapse: 'up', postgres: 'up', dex: 'up', netlify: 'up', gateway: 'up' },
});

describe('1. argument parsing', () => {
  it('rejects an unknown human with invalid_human (exit 1 from the CLI)', () => {
    assert.equal(codeOf(() => parseArgs(['say', '--as', 'a3', '--text', 'hi'])), 'invalid_human');
    const run = spawnSync(process.execPath, [script, 'say', '--as', 'a3', '--text', 'hi'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /invalid_human/u);
    assert.equal(run.stderr.trim().split('\n').length, 1);
    assert.equal(run.stdout, '');
  });

  it('requires --url for confirm', () => {
    assert.equal(codeOf(() => parseArgs(['confirm', '--as', 'a1'])), 'missing_url');
  });

  it('defaults a1 to 9222 and a2 to 9223, and --port overrides', () => {
    assert.equal(parseArgs(['whoami', '--as', 'a1']).port, 9222);
    assert.equal(parseArgs(['whoami', '--as', 'a2']).port, 9223);
    assert.equal(parseArgs(['whoami', '--as', 'a2', '--port', '9300']).port, 9300);
  });

  it('validates the rest of the command surface', () => {
    assert.equal(codeOf(() => parseArgs(['dance'])), 'unknown_command');
    assert.equal(codeOf(() => parseArgs(['say', '--as', 'a1'])), 'missing_text');
    assert.equal(codeOf(() => parseArgs(['wait-for', '--as', 'a2'])), 'missing_text');
    assert.equal(codeOf(() => parseArgs(['cleanup'])), 'missing_human');
    assert.equal(codeOf(() => parseArgs(['setup', '--as', 'a1'])), 'unexpected_human');
    assert.equal(codeOf(() => parseArgs(['whoami', '--as', 'a1', '--port', 'x'])), 'invalid_port');
    assert.equal(codeOf(() => parseArgs(['whoami', '--as', 'a1', '--bogus', '1'])), 'unknown_flag');
    assert.equal(codeOf(() => parseArgs(['signin', '--as', 'a1', '--origin', 'http://example.com'])), 'invalid_origin');
    const options = parseArgs(['transcript', '--as', 'a1', '--reload', '--origin', 'https://khala.example/x']);
    assert.equal(options.reload, true);
    assert.equal(options.origin, 'https://khala.example');
    assert.equal(parseArgs(['wait-for', '--as', 'a1', '--text', 't', '--timeout', '12']).timeout, 12);
    assert.match(parseArgs(['setup']).stateDir, /\.khala-local[/\\]acceptance$/u);
  });
});

describe('2. stack:status selection', () => {
  it('selects users[0] for a1 and users[1] for a2', () => {
    assert.deepEqual(selectDexUser(STATUS, 'a1'), { email: 'alice@khala.local', password: 'pw-a' });
    assert.deepEqual(selectDexUser(STATUS, 'a2'), { email: 'bob@khala.local', password: 'pw-b' });
    assert.equal(codeOf(() => selectDexUser({ ...STATUS, users: [] }, 'a2')), 'dex_user_unavailable');
  });

  it('defaults the origin to stack:status .origin; --origin wins without reading status', () => {
    assert.equal(resolveOrigin({}, () => STATUS), 'https://127.0.0.1:8443');
    let read = false;
    assert.equal(resolveOrigin({ origin: 'https://khala.example' }, () => { read = true; return STATUS; }), 'https://khala.example');
    assert.equal(read, false);
    assert.equal(codeOf(() => resolveOrigin({}, () => ({}))), 'stack_status_unavailable');
  });

  it('plans a Dex sign-in for the loopback origin', () => {
    assert.deepEqual(planSignin({ origin: STATUS.origin, as: 'a2' }, () => STATUS),
      { provider: 'dex', user: { email: 'bob@khala.local', password: 'pw-b' } });
  });
});

describe('3. non-loopback origins', () => {
  it('requires --account for signin and never reads Dex credentials', () => {
    let read = false;
    const loadStatus = () => { read = true; return STATUS; };
    assert.equal(codeOf(() => planSignin({ origin: 'https://khala.example', as: 'a1' }, loadStatus)), 'missing_account');
    assert.deepEqual(planSignin({ origin: 'https://khala.example', as: 'a1', account: 'a@gmail.com' }, loadStatus),
      { provider: 'google', account: 'a@gmail.com' });
    assert.equal(read, false);
  });

  it('refuses trust-local with not_loopback', async () => {
    const { assertLoopback } = await import('./humans.mjs');
    assert.equal(codeOf(() => assertLoopback('https://khala.example', 'trust-local')), 'not_loopback');
    assert.doesNotThrow(() => assertLoopback('https://127.0.0.1:8443', 'trust-local'));
    assert.equal(isLoopbackOrigin('https://localhost:8443'), true);
    assert.equal(isLoopbackOrigin('https://khala.example'), false);
  });
});

describe('4. BiDi request/response matcher', () => {
  it('resolves out-of-order replies to the right requests', async () => {
    const matcher = createBidiMatcher();
    const first = matcher.request('browsingContext.getTree', { maxDepth: 0 });
    const second = matcher.request('browsingContext.create', { type: 'tab', background: true });
    assert.deepEqual(JSON.parse(first.message), { id: first.id, method: 'browsingContext.getTree', params: { maxDepth: 0 } });
    assert.notEqual(first.id, second.id);
    assert.equal(matcher.handle(JSON.stringify({ type: 'success', id: second.id, result: { context: 'tab-2' } })), true);
    assert.equal(matcher.handle(JSON.stringify({ type: 'event', method: 'log.entryAdded', params: {} })), false);
    assert.equal(matcher.handle(JSON.stringify({ type: 'success', id: first.id, result: { contexts: [] } })), true);
    assert.deepEqual(await second.promise, { context: 'tab-2' });
    assert.deepEqual(await first.promise, { contexts: [] });
    assert.equal(matcher.size, 0);
  });

  it("rejects a type: 'error' reply with its error code", async () => {
    const matcher = createBidiMatcher();
    const request = matcher.request('session.new', { capabilities: {} });
    matcher.handle({ type: 'error', id: request.id, error: 'session not created', message: 'Maximum number of active sessions' });
    await assert.rejects(request.promise, error => error.code === 'session not created' && /Maximum number/u.test(error.message));
  });

  it('ignores unknown ids and rejects everything pending on close', async () => {
    const matcher = createBidiMatcher();
    const request = matcher.request('session.end');
    assert.equal(matcher.handle({ type: 'success', id: 999, result: {} }), false);
    assert.equal(matcher.handle('not json'), false);
    matcher.rejectAll(new DriverError('bidi_closed', 'transport'));
    await assert.rejects(request.promise, error => error.code === 'bidi_closed');
  });
});

describe('helpers', () => {
  it('parses the join page channel line', () => {
    assert.equal(parseChannelLine('Channel: !abc:khala.local'), '!abc:khala.local');
    assert.equal(parseChannelLine('nothing here'), null);
  });

  it('marks tabs with per-human tokens and only probes run-origin or Google tabs', () => {
    assert.match(newTabToken('a1'), /^khala-acc-a1-[0-9a-f-]{36}$/u);
    assert.notEqual(newTabToken('a2'), newTabToken('a2'));
    assert.equal(isMarkerCandidate('https://127.0.0.1:8443/channels/x', 'https://127.0.0.1:8443'), true);
    assert.equal(isMarkerCandidate('https://accounts.google.com/o/oauth2', 'https://khala.example'), true);
    assert.equal(isMarkerCandidate('https://127.0.0.1:9999/', 'https://127.0.0.1:8443'), false);
    assert.equal(isMarkerCandidate('about:blank', 'https://127.0.0.1:8443'), false);
  });
});
