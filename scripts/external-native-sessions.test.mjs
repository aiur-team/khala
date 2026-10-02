import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { proofFingerprint } from './external-native-sessions.mjs';

test('preapproval fingerprint comes from the exact private hosted signer ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-external-native-'));
  fs.chmodSync(root, 0o700);
  try {
    const actor = 'codex';
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    const workdir = path.join(root, 'work');
    const state = path.join(root, 'state');
    const hash = createHash('sha256').update(JSON.stringify([
      'khala.hosted.session.v1', actor, sessionId, workdir,
    ])).digest('hex');
    const directory = path.join(state, 'khala', 'hosted', hash, 'state');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'ledger.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE bootstrap_signer (singleton INTEGER PRIMARY KEY, private_key BLOB NOT NULL)');
    const key = generateKeyPairSync('ed25519').privateKey;
    db.prepare('INSERT INTO bootstrap_signer VALUES (1, ?)').run(key.export({ format: 'der', type: 'pkcs8' }));
    db.close();
    fs.chmodSync(file, 0o600);
    const publicJwk = createPublicKey(key).export({ format: 'jwk' });
    const expected = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: publicJwk.x })).digest('base64url');
    const input = { directory: workdir, roots: { state } };
    assert.equal(proofFingerprint(input, actor, sessionId), expected);
    assert.equal(proofFingerprint(input, 'claude', sessionId), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
