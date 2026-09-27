import { describe, expect, it } from 'vitest';
import { ORIGIN, SECRET, ROOM_ID, T0, harness, principal } from '../../invitations/support.test';
import { createInviteEvidenceReader, matchesInviteEvidence } from './invite-evidence';

describe('owner-approved per-link admission evidence', () => {
  it('pins named-email policy and authoritative revision, then rejects wrong owner, mutation and revocation', async () => {
    const h = harness();
    const shared = await h.service.share({
      operationId: 'share-named', roomId: ROOM_ID,
      policy: { v: 1, kind: 'named_email', email: 'ada@example.test', history: 'none' },
    });
    expect(shared.kind).toBe('ok');
    if (shared.kind !== 'ok') return;
    const inviteRef = shared.value.inviteRef;
    const reader = createInviteEvidenceReader({ store: h.store.store, secret: SECRET, clock: () => T0 });
    const owner = principal();
    const evidence = await reader(owner, inviteRef);
    expect(evidence).toMatchObject({ roomId: ROOM_ID, revision: expect.any(String), policyDigest: expect.any(String) });
    expect(await reader(principal('other-owner', 'other@example.test'), inviteRef)).toBeNull();
    expect(await matchesInviteEvidence({
      store: h.store.store, secret: SECRET, clock: () => T0,
      principal: owner, inviteRef, expected: evidence!,
    })).toBe(true);

    // A concurrent authorization changes the authoritative invite revision.
    const record = [...h.store.records.values()].find(value => value.value && typeof value.value === 'object'
      && 'inviteRefDigest' in value.value)!;
    h.store.records.set(record.key, { ...record, revision: `${record.revision}.new` });
    expect(await matchesInviteEvidence({
      store: h.store.store, secret: SECRET, clock: () => T0,
      principal: owner, inviteRef, expected: evidence!,
    })).toBe(false);
    expect(await h.service.revoke({ operationId: 'revoke-named', inviteRef })).toEqual({ kind: 'ok', value: null });
    expect(await reader(owner, inviteRef)).toBeNull();
    expect(shared.value.shareUrl).toBe(`${ORIGIN}/join/${inviteRef}`);
  });
});
