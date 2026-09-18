import { describe, expect, it } from 'vitest';
import type { ControlStore } from '@khala/contracts/messaging/index';
import type { InviteRecord } from './policy';
import { LINK_NO_HISTORY, ORIGIN, ROOM_ID, T0, fakeStore, harness } from './support.test';

describe('share', () => {
  it('issues a reusable no-history link and reconciles repeated issuance', async () => {
    const h = harness();
    const first = await h.service.share({ operationId: 'share-1', roomId: ROOM_ID, policy: LINK_NO_HISTORY });
    const retry = await h.service.share({ operationId: 'share-1', roomId: ROOM_ID, policy: LINK_NO_HISTORY });
    expect(retry).toEqual(first);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.shareUrl).toBe(`${ORIGIN}/join/${first.value.inviteRef}`);
    expect(JSON.stringify([...h.store.records.values()])).not.toContain(first.value.inviteRef);
  });

  it('rejects operation reuse with a different per-link policy', async () => {
    const h = harness();
    await h.service.share({ operationId: 'share-1', roomId: ROOM_ID, policy: LINK_NO_HISTORY });
    expect(await h.service.share({
      operationId: 'share-1', roomId: ROOM_ID, policy: { v: 1, kind: 'link', history: 'full' },
    })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
  });

  it('keeps the original expiry when the same share operation is retried later', async () => {
    const h = harness();
    const first = await h.service.share({ operationId: 'share-1', roomId: ROOM_ID, policy: LINK_NO_HISTORY });
    h.advance(60_000);
    expect(await h.service.share({ operationId: 'share-1', roomId: ROOM_ID, policy: LINK_NO_HISTORY })).toEqual(first);
  });

  it('requires room authority and an allowlisted origin', async () => {
    const denied = harness({ authority: { async canShare() { return 'forbidden'; } } });
    expect(await denied.service.share({ operationId: 'share-1', roomId: ROOM_ID, policy: LINK_NO_HISTORY })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(() => harness({ origin: 'https://evil.example.test' })).toThrow(/allowlisted/);
  });

  it('stores a named restriction without storing the email', async () => {
    const h = harness();
    const result = await h.service.share({
      operationId: 'share-named', roomId: ROOM_ID,
      policy: { v: 1, kind: 'named_email', email: 'Coworker@Example.Test', history: 'none' },
    });
    expect(result.kind).toBe('ok');
    expect(JSON.stringify([...h.store.records.values()])).not.toContain('Coworker@Example.Test');
    expect(JSON.stringify([...h.store.records.values()])).not.toContain('coworker@example.test');
  });

  it('keeps revoke operation bytes stable when authorization wins a CAS race', async () => {
    const backing = fakeStore(() => T0);
    let raced = false;
    const store: ControlStore = {
      ...backing.store,
      async compareAndSet(input, options) {
        if (!raced && input.operationId.startsWith('invitation.revoke.')) {
          raced = true;
          const current = backing.records.get(input.key);
          if (!current) throw new Error('expected invite record before revoke race');
          backing.records.set(input.key, {
            ...current,
            revision: `${current.revision}.authorized`,
            operationId: 'invitation.authorize.concurrent',
            value: {
              ...(current.value as InviteRecord),
              lastAuthorizedOperationDigest: 'concurrent-authorization',
            },
          });
        }
        return backing.store.compareAndSet(input, options);
      },
    };
    const h = harness({ store });
    const shared = await h.service.share({ operationId: 'share-race', roomId: ROOM_ID, policy: LINK_NO_HISTORY });
    expect(shared.kind).toBe('ok');
    if (shared.kind !== 'ok') return;

    expect(await h.service.revoke({ operationId: 'revoke-race', inviteRef: shared.value.inviteRef }))
      .toEqual({ kind: 'ok', value: null });
    expect([...backing.records.values()][0]?.value).toMatchObject({
      status: 'revoked',
      lastAuthorizedOperationDigest: null,
    });
  });
});
