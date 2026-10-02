import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseExternalCommand, sanitizeConsumerDiagnostic } from './external-local.mjs';

describe('disposable external command arguments', () => {
  it('accepts direct node and pnpm forwarding spellings', () => {
    assert.deepEqual(parseExternalCommand([]), null);
    assert.deepEqual(parseExternalCommand(['--exec', 'node', 'test.mjs']), ['node', 'test.mjs']);
    assert.deepEqual(parseExternalCommand(['--', '--exec', 'node', 'test.mjs']), ['node', 'test.mjs']);
  });
  it('rejects missing commands and extra runner arguments', () => {
    for (const argv of [['--'], ['--exec'], ['--', '--exec'], ['foo'], ['foo', '--exec', 'node']]) {
      assert.throws(() => parseExternalCommand(argv), /invalid_exec_arguments/);
    }
  });
});

describe('consumer failure diagnostic', () => {
  it('retains only one safe stage and drops message bodies and URLs', () => {
    assert.deepEqual(sanitizeConsumerDiagnostic({ stage: 'external_native_provider_auth', body: 'private text', url: 'https://secret.invalid' }),
      { stage: 'external_native_provider_auth' });
    assert.equal(sanitizeConsumerDiagnostic({ stage: 'https://secret.invalid' }), null);
    assert.equal(sanitizeConsumerDiagnostic({ stage: 'body\nsecret' }), null);
  });
});
