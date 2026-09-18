import { describe, expect, it } from 'vitest';
import { DEVICE_ID, ROOM_ID, harness, principal } from './support.test';

async function namedInvite() {
  const h = harness();
  const shared = await h.service.share({
    operationId: 'named', roomId: ROOM_ID,
    policy: { v: 1, kind: 'named_email', email: 'coworker@example.test', history: 'none' },
  });
  if (shared.kind !== 'ok') throw new Error('share failed');
  return { h, inviteRef: shared.value.inviteRef };
}

describe('inspect', () => {
  it('keeps joined full-history invitations eligible until history is ready', async () => {
    const h = harness();
    const shared = await h.service.share({
      operationId: 'full-history', roomId: ROOM_ID,
      policy: { v: 1, kind: 'link', history: 'full' },
    });
    if (shared.kind !== 'ok') throw new Error('share failed');
    h.failAdmission('history_unavailable');
    expect((await h.service.admit({
      operationId: 'admit-full-history', inviteRef: shared.value.inviteRef, deviceId: DEVICE_ID,
    })).kind).toBe('outcome_unknown');

    expect(await h.service.inspect(shared.value.inviteRef)).toBe('eligible');

    expect((await h.service.admit({
      operationId: 'admit-full-history', inviteRef: shared.value.inviteRef, deviceId: DEVICE_ID,
    })).kind).toBe('ok');
    expect(await h.service.inspect(shared.value.inviteRef)).toBe('already_joined');
  });

  it('keeps joined no-history invitations terminal', async () => {
    const h = harness();
    const shared = await h.service.share({ operationId: 'no-history', roomId: ROOM_ID });
    if (shared.kind !== 'ok') throw new Error('share failed');
    expect((await h.service.admit({
      operationId: 'admit-no-history', inviteRef: shared.value.inviteRef, deviceId: DEVICE_ID,
    })).kind).toBe('ok');

    expect(await h.service.inspect(shared.value.inviteRef)).toBe('already_joined');
  });

  it('keeps joined named no-history invitations terminal', async () => {
    const { h, inviteRef } = await namedInvite();
    h.setPrincipal(principal('owner_2', 'coworker@example.test'));
    expect((await h.service.admit({
      operationId: 'admit-named-no-history', inviteRef, deviceId: DEVICE_ID,
    })).kind).toBe('ok');

    expect(await h.service.inspect(inviteRef)).toBe('already_joined');
  });

  it('does not disclose invitation state before authentication', async () => {
    const { h, inviteRef } = await namedInvite();
    h.setPrincipal(null);
    expect(await h.service.inspect(inviteRef)).toBe('auth_required');
  });

  it('returns identity_mismatch without revealing the named email', async () => {
    const { h, inviteRef } = await namedInvite();
    h.setPrincipal(principal('owner_2', 'other@example.test'));
    expect(await h.service.inspect(inviteRef)).toBe('identity_mismatch');
  });

  it('distinguishes expiry and revocation without returning room content', async () => {
    const expired = await namedInvite();
    expired.h.setPrincipal(principal('owner_2', 'coworker@example.test'));
    expired.h.advance(3600_000);
    expect(await expired.h.service.inspect(expired.inviteRef)).toBe('expired');

    const revoked = await namedInvite();
    expect((await revoked.h.service.revoke({ operationId: 'revoke-1', inviteRef: revoked.inviteRef })).kind).toBe('ok');
    revoked.h.setPrincipal(principal('owner_2', 'coworker@example.test'));
    expect(await revoked.h.service.inspect(revoked.inviteRef)).toBe('revoked');
  });

  it('returns unavailable on a store outage', async () => {
    const { h, inviteRef } = await namedInvite();
    h.store.inject('read', 'unavailable');
    expect(await h.service.inspect(inviteRef)).toBe('unavailable');
  });
});
