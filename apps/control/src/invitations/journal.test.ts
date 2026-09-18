import type { DeviceId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { DEVICE_ID, ROOM_ID, harness, principal } from './support.test';

const OTHER_DEVICE_ID = 'device_2' as DeviceId;

async function bearerInvite() {
  const h = harness();
  const shared = await h.service.share({ operationId: 'share-1', roomId: ROOM_ID });
  if (shared.kind !== 'ok') throw new Error('share failed');
  h.setPrincipal(principal('recipient'));
  return { h, inviteRef: shared.value.inviteRef };
}

describe('admission journal', () => {
  it('binds operation ID to principal, device, invite and policy revision', async () => {
    const { h, inviteRef } = await bearerInvite();
    expect((await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID })).kind).toBe('ok');

    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: OTHER_DEVICE_ID }))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });

    h.setPrincipal(principal('another-recipient'));
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
  });

  it('does not turn a store outage into eligibility', async () => {
    const { h, inviteRef } = await bearerInvite();
    h.store.inject('read', 'unavailable');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'unavailable', retryable: true });
  });

  it('preserves an ambiguous journal write when its read-back is unavailable', async () => {
    const { h, inviteRef } = await bearerInvite();
    h.store.inject('compareAndSet', 'outcome_unknown');
    h.store.inject('resolve', 'unavailable');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'outcome_unknown', operationId: 'admit-1' });
  });

  it('converges concurrent retries on one membership operation', async () => {
    const { h, inviteRef } = await bearerInvite();
    const results = await Promise.all([1, 2].map(() => h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID })));
    expect(results.every(result => result.kind === 'ok')).toBe(true);
    expect(new Set(h.admits)).toEqual(new Set(['admit-1']));
  });
});
