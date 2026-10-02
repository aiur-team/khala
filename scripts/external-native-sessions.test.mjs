import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { proofCandidate, proofFingerprint } from './external-native-sessions.mjs';

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
