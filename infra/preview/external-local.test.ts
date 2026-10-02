import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseExternalCommand } from './external-local.mjs';

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
