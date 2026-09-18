import { describe, expect, it } from 'vitest';
import { DEVICE_ID, ROOM_ID, harness, principal } from './support.test';

async function invite(history: 'none' | 'full' = 'none') {
  const h = harness();
  const shared = await h.service.share({
    operationId: `share-${history}`, roomId: ROOM_ID, policy: { v: 1, kind: 'link', history },
  });
  if (shared.kind !== 'ok') throw new Error('share failed');
  h.setPrincipal(principal('recipient'));
  return { h, inviteRef: shared.value.inviteRef };
}

async function namedInvite() {
  const h = harness();
  const shared = await h.service.share({
    operationId: 'share-named', roomId: ROOM_ID,
    policy: { v: 1, kind: 'named_email', email: 'coworker@example.test', history: 'none' },
  });
  if (shared.kind !== 'ok') throw new Error('share failed');
  return { h, inviteRef: shared.value.inviteRef };
}

describe('admit', () => {
  it('covers AE1: retry returns the existing membership without duplicating it', async () => {
    const { h, inviteRef } = await invite();
    const first = await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID });
    const retry = await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID });
    expect(first).toMatchObject({ kind: 'ok', value: { outcome: 'joined' } });
    expect(retry).toMatchObject({ kind: 'ok', value: { outcome: 'already_joined' } });
    expect(h.admits).toEqual(['admit-1']);
  });

  it('reconciles membership when the provider accepted it but lost the response', async () => {
    const { h, inviteRef } = await invite();
    h.failAdmission('outcome_unknown');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toMatchObject({ kind: 'ok', value: { outcome: 'joined' } });
    expect(h.admits).toEqual(['admit-1']);
  });

  it('enforces the named recipient before invoking the membership gateway', async () => {
    const { h, inviteRef } = await namedInvite();
    h.setPrincipal(principal('recipient', 'other@example.test'));
    expect(await h.service.admit({ operationId: 'admit-wrong-email', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'rejected', code: 'identity_mismatch' });
    expect(h.admits).toEqual([]);

    h.setPrincipal(principal('recipient', 'coworker@example.test'));
    expect(await h.service.admit({ operationId: 'admit-matching-email', inviteRef, deviceId: DEVICE_ID }))
      .toMatchObject({ kind: 'ok', value: { outcome: 'joined' } });
    expect(h.admits).toEqual(['admit-matching-email']);
  });

  it('rejects an expired invite before invoking the membership gateway', async () => {
    const { h, inviteRef } = await namedInvite();
    h.setPrincipal(principal('recipient', 'coworker@example.test'));
    h.advance(3600_000);

    expect(await h.service.admit({ operationId: 'admit-expired', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'rejected', code: 'expired' });
    expect(h.admits).toEqual([]);
  });

  it('reconciles membership when the provider commits and then throws', async () => {
    const { h, inviteRef } = await invite();
    h.failAdmission('throw_after_commit');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toMatchObject({ kind: 'ok', value: { outcome: 'joined' } });
    expect(h.admits).toEqual(['admit-1']);
  });

  it('keeps full-history admission unknown until history disclosure is ready', async () => {
    const { h, inviteRef } = await invite('full');
    h.failAdmission('history_unavailable');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'outcome_unknown', operationId: 'admit-1' });
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toMatchObject({ kind: 'ok', value: { outcome: 'joined' } });
    expect(h.histories).toEqual(['admit-1', 'admit-1']);
  });

  it('completes no-history admission without requiring a history-ready signal', async () => {
    const { h, inviteRef } = await invite();
    h.failAdmission('history_unavailable');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toMatchObject({ kind: 'ok', value: { outcome: 'joined' } });
    expect(h.admits).toEqual(['admit-1']);
    expect(h.histories).toEqual([]);
  });

  it('does not hide committed membership when a full-history invite is later revoked', async () => {
    const { h, inviteRef } = await invite('full');
    h.failAdmission('history_unavailable');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'outcome_unknown', operationId: 'admit-1' });

    h.setPrincipal(principal());
    expect((await h.service.revoke({ operationId: 'revoke-1', inviteRef })).kind).toBe('ok');
    h.setPrincipal(principal('recipient'));
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'outcome_unknown', operationId: 'admit-1' });
    expect(h.admits).toEqual(['admit-1']);
  });

  it('rejects revocation before admission but preserves a committed result after revocation', async () => {
    const before = await invite();
    before.h.setPrincipal(principal());
    await before.h.service.revoke({ operationId: 'revoke-before', inviteRef: before.inviteRef });
    before.h.setPrincipal(principal('recipient'));
    expect(await before.h.service.admit({ operationId: 'admit-1', inviteRef: before.inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'rejected', code: 'revoked' });

    const after = await invite();
    expect((await after.h.service.admit({ operationId: 'admit-2', inviteRef: after.inviteRef, deviceId: DEVICE_ID })).kind).toBe('ok');
    after.h.setPrincipal(principal());
    await after.h.service.revoke({ operationId: 'revoke-after', inviteRef: after.inviteRef });
    after.h.setPrincipal(principal('recipient'));
    expect(await after.h.service.admit({ operationId: 'admit-2', inviteRef: after.inviteRef, deviceId: DEVICE_ID }))
      .toMatchObject({ kind: 'ok', value: { outcome: 'already_joined' } });
  });

  it('rechecks revocation before retrying a pending admission effect', async () => {
    const { h, inviteRef } = await invite();
    h.failAdmission('unavailable');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'unavailable', retryable: true });

    h.setPrincipal(principal());
    expect((await h.service.revoke({ operationId: 'revoke-1', inviteRef })).kind).toBe('ok');
    h.setPrincipal(principal('recipient'));
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'rejected', code: 'revoked' });
    expect(h.admits).toEqual(['admit-1']);
  });

  it('rechecks expiry before retrying a pending admission effect', async () => {
    const { h, inviteRef } = await invite();
    h.failAdmission('unavailable');
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'unavailable', retryable: true });

    h.advance(3600_000);
    expect(await h.service.admit({ operationId: 'admit-1', inviteRef, deviceId: DEVICE_ID }))
      .toEqual({ kind: 'rejected', code: 'expired' });
    expect(h.admits).toEqual(['admit-1']);
  });
});
