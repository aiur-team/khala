import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { installDisposableBrowserTrust, installStagedBrowserTrust, nativeIdle, pendingMcpApproval, proofCandidate, proofFingerprint, validateDiscoveryOpen } from './external-native-sessions.mjs';

test('disposable Chromium wrapper trusts only the pinned certificate key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-external-browser-test-'));
  fs.chmodSync(root, 0o700);
  const descriptor = path.join(root, 'descriptor.json');
  const cli = path.join(root, 'installed', 'node_modules', '@aiur', 'khala', 'dist', 'khala.js');
  const spki = `${'A'.repeat(43)}=`;
  try {
    assert.throws(() => installDisposableBrowserTrust(cli, descriptor, 'invalid'), /disposable_browser_provenance/);
    assert.throws(() => installDisposableBrowserTrust(path.join(root, 'other.js'), descriptor, spki), /disposable_browser_provenance/);
    const wrapper = installDisposableBrowserTrust(cli, descriptor, spki);
    const body = fs.readFileSync(wrapper, 'utf8');
    assert.match(body, /--ignore-certificate-errors-spki-list='A{43}='/u);
    assert.doesNotMatch(body, /--ignore-certificate-errors\s/u);
    assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700);
    const version = spawnSync(wrapper, ['--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0);
    assert.match(version.stdout, /^Chromium 15[0-3]\./u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude staged launcher gets the same private certificate pin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-external-staged-browser-test-'));
  fs.chmodSync(root, 0o700);
  const runtime = path.join(root, 'khala', 'versions', '0.1.0', 'khala.js');
  const spki = `${'B'.repeat(43)}=`;
  try {
    fs.mkdirSync(path.dirname(runtime), { recursive: true, mode: 0o700 });
    assert.throws(() => installStagedBrowserTrust(root, '0.1.0', spki), /staged_runtime_missing/);
    fs.writeFileSync(runtime, 'runtime', { mode: 0o600 });
    assert.throws(() => installStagedBrowserTrust(root, '../other', spki), /disposable_browser_provenance/);
    assert.throws(() => installStagedBrowserTrust(root, '0.1.0', 'invalid'), /disposable_browser_provenance/);
    const wrapper = installStagedBrowserTrust(root, '0.1.0', spki);
    assert.equal(wrapper, path.join(root, 'khala', 'versions', '0.1.0', 'chromium', 'chrome-linux64', 'chrome'));
    assert.match(fs.readFileSync(wrapper, 'utf8'), /--ignore-certificate-errors-spki-list='B{43}='/u);
    assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native stop removes only its exact short private TMPDIR alias', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-external-alias-test-'));
  fs.chmodSync(root, 0o700);
  const target = path.join(root, 'tmp');
  fs.mkdirSync(target, { mode: 0o700 });
  const alias = path.join('/tmp', `k8-${randomBytes(12).toString('hex')}`);
  fs.symlinkSync(target, alias, 'dir');
  fs.writeFileSync(path.join(root, 'native-sessions.json'), JSON.stringify({ socket: path.join(root, 'missing.sock'),
    env: { PATH: '/usr/bin:/bin' }, roots: { tmp: target }, tmpAlias: alias }) + '\n', { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [path.resolve('scripts/external-native-sessions.mjs'), 'stop', root],
      { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(alias), false);
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native prompts wait until the previous model turn is idle', () => {
  assert.equal(nativeIdle('› Ask Codex to do anything\nGPT-6.1-Sol default', 'codex'), true);
  assert.equal(nativeIdle('• Working (9s • esc to interrupt)\n› Ask Codex to do anything', 'codex'), false);
  assert.equal(nativeIdle('Allow the khala MCP server to run tool "khala_read"?\n› Ask Codex to do anything', 'codex'), false);
  assert.equal(nativeIdle('Hooks need review\nt trust all · enter review · esc close\n› Ask Codex to do anything', 'codex'), false);
  assert.equal(nativeIdle('❯\n⏵⏵ auto mode on', 'claude'), true);
  assert.equal(nativeIdle('✻ Working (2s • esc to interrupt)\n❯\n⏵⏵ auto mode on', 'claude'), false);
});

test('browser handoff is exact-session discovery consent on loopback only', () => {
  const origin = 'https://127.0.0.1:4443';
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const fingerprint = 'A'.repeat(43);
  const state = { origin, actors: { codex: { sessionId, sessionFingerprint: fingerprint,
    candidate: { candidateId: 'B'.repeat(43), operationId: 'op-1' } } } };
  const url = new URL('/api/human/channel-discovery/bootstrap/authorize', origin);
  url.search = new URLSearchParams({ redirect_uri: 'http://127.0.0.1:45999/khala/channel-discovery/callback/0123456789abcdef',
    state: 'C'.repeat(22), code_challenge: 'D'.repeat(43), code_challenge_method: 'S256', origin,
    harness: 'codex', session_id: sessionId, generation: '0', proof_jkt: fingerprint }).toString();
  assert.deepEqual(validateDiscoveryOpen(state, url.href), { actor: 'codex', url: url.href });
  url.searchParams.set('proof_jkt', 'E'.repeat(43));
  assert.throws(() => validateDiscoveryOpen(state, url.href), /browser_handoff_session_mismatch/);
  url.searchParams.set('proof_jkt', fingerprint);
  url.searchParams.set('redirect_uri', 'http://example.com/khala/channel-discovery/callback/0123456789abcdef');
  assert.throws(() => validateDiscoveryOpen(state, url.href), /browser_handoff_session_mismatch/);
});

test('native consent recognizes only an exact Khala tool and session-scoped choice', () => {
  const pane = 'Allow the khala MCP server to run tool "khala_request_channel_access"?\n'
    + '1. Allow\n2. Allow for this session\n4. Cancel\nenter to submit';
  assert.equal(pendingMcpApproval(pane), 'khala_request_channel_access');
  assert.equal(pendingMcpApproval(pane.replace('khala MCP server', 'other MCP server')), null);
  assert.throws(() => pendingMcpApproval(pane.replace('khala_request_channel_access', 'khala_pair')),
    /unexpected_mcp_tool/);
  assert.throws(() => pendingMcpApproval(pane.replace('Allow for this session', 'Always allow')),
    /mcp_approval_screen_unproven/);
});

test('candidate ID is taken only from a matching native tool result', () => {
  const candidateId = 'A'.repeat(43);
  const outcome = { ok: true, operationId: 'e2e-request-1', outcome: 'pending_owner',
    stage: 'proof_key_candidate', candidateId, next: 'approve_proof_key' };
  const codex = [{ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: JSON.stringify(outcome) } }, { type: 'response_item', payload: {
    type: 'mcp_tool_call', tool: 'khala__khala_request_channel_access',
    arguments: JSON.stringify({ operationId: outcome.operationId }), result: { structuredContent: outcome },
  } }];
  const claude = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1',
    name: 'mcp__khala__khala_request_channel_access', input: { operationId: outcome.operationId } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1',
    content: [{ type: 'text', text: JSON.stringify(outcome) }] }] } }];
  assert.equal(proofCandidate(codex.slice(0, 1), 'codex'), null);
  assert.deepEqual(proofCandidate(codex, 'codex'), { candidateId, operationId: outcome.operationId });
  assert.deepEqual(proofCandidate(claude, 'claude'), { candidateId, operationId: outcome.operationId });
  const codeMode = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-1',
      input: `const result = await tools.mcp__khala__khala_request_channel_access({operationId: '${outcome.operationId}'}); text(result);` } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1',
      output: `Tool result: ${JSON.stringify(outcome)}` } },
  ];
  assert.deepEqual(proofCandidate(codeMode, 'codex'), { candidateId, operationId: outcome.operationId });
  assert.equal(proofCandidate([{ ...codeMode[0], payload: { ...codeMode[0].payload,
    input: `text('khala_request_channel_access ${outcome.operationId}')` } }, codeMode[1]], 'codex'), null);
  assert.equal(proofCandidate([{ ...codex[1], payload: { ...codex[1].payload,
    arguments: JSON.stringify({ operationId: 'wrong' }) } }], 'codex'), null);
});

test('preapproval fingerprint comes from the exact private hosted signer ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-external-native-'));
  fs.chmodSync(root, 0o700);
  try {
    const actor = 'codex';
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    const workdir = path.join(root, 'work');
    fs.mkdirSync(workdir, { mode: 0o700 });
    const state = path.join(root, 'state');
    const hash = createHash('sha256').update(JSON.stringify([
      'khala.hosted.session.v1', actor, sessionId, workdir,
    ])).digest('hex');
    const directory = path.join(state, 'khala', 'hosted', hash, 'state');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'ledger.sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; BEGIN EXCLUSIVE; CREATE TABLE bootstrap_signer (singleton INTEGER PRIMARY KEY, private_key BLOB NOT NULL)');
    const key = generateKeyPairSync('ed25519').privateKey;
    db.prepare('INSERT INTO bootstrap_signer VALUES (1, ?)').run(key.export({ format: 'der', type: 'pkcs8' }));
    db.exec('COMMIT');
    fs.chmodSync(file, 0o600);
    if (fs.existsSync(`${file}-wal`)) fs.chmodSync(`${file}-wal`, 0o600);
    const publicJwk = createPublicKey(key).export({ format: 'jwk' });
    const expected = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: publicJwk.x })).digest('base64url');
    const input = { directory: workdir, roots: { state } };
    assert.equal(proofFingerprint(input, actor, sessionId), expected);
    assert.equal(proofFingerprint(input, 'claude', sessionId), null);
    db.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
