import type { OwnerId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createRecoveryService } from './service';

const alice = 'owner_alice' as OwnerId;

function service() {
  return createRecoveryService({
    ownerId: alice,
    identity: {
      async current() { return { kind: 'signed_in' as const, ownerId: alice }; },
    },
  });
}

describe('no-recovery service', () => {
  it('reports the approved no-recovery policy', async () => {
    expect(await service().capabilities()).toEqual({ modes: [], unavailableReason: 'unsupported_substrate' });
  });

  it('never requests a secret or creates an operation', async () => {
    const recovery = service();
    let prompts = 0;
    expect(await recovery.begin({ operationId: 'recover_1', mode: 'server-backup' }, async () => {
      prompts += 1;
      return new Uint8Array([1, 2, 3]);
    })).toEqual({ kind: 'rejected', code: 'unsupported_mode' });
    expect(prompts).toBe(0);
    expect(await recovery.inspect('recover_1')).toEqual({ kind: 'rejected', code: 'not_found' });
  });

  it('does nothing for an already-aborted caller', async () => {
    const abort = new AbortController();
    abort.abort();
    let prompts = 0;
    const recovery = service();
    expect(await recovery.begin({ operationId: 'recover_abort', mode: 'anything' }, async () => {
      prompts += 1;
      return new Uint8Array([9]);
    }, { signal: abort.signal })).toEqual({ kind: 'unavailable', retryable: true });
    expect(await recovery.inspect('recover_abort', { signal: abort.signal }))
      .toEqual({ kind: 'unavailable', retryable: true });
    expect(prompts).toBe(0);
  });
});
