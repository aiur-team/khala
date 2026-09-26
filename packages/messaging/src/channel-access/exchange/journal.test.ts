import { describe, expect, it } from 'vitest';
import { type ExchangeRecord, decodeRecord, exchangeJournal } from './journal';
import { DEVICE, FINGERPRINT, ORIGIN, REQUESTER, T0, fakeControlStore } from './support.test';

const identity = { requester: REQUESTER, origin: ORIGIN, operationId: 'op_access_1' };
const record: ExchangeRecord = {
  v: 1,
  seq: 1,
  operationId: 'op_access_1',
  requester: REQUESTER,
  origin: ORIGIN,
  sessionGeneration: 3,
  sessionFingerprint: FINGERPRINT,
  deviceId: DEVICE,
  proofKeyThumbprint: 'p'.repeat(43),
  encryptionPublicKey: 'k'.repeat(43),
  encryptionKeyThumbprint: 't'.repeat(43),
  providerOperationId: 'caadmit_1',
  createdAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 60_000).toISOString(),
  phase: 'bound',
  membership: null,
  envelope: null,
  closed: null,
};

describe('grant exchange journal', () => {
  it('round-trips a record and advances it by compare-and-set', async () => {
    const backing = fakeControlStore();
    const journal = exchangeJournal(backing.store);
    const key = (await journal.key(identity))!;
    const created = await journal.create(key, record);
    expect(created.kind).toBe('saved');
    const loaded = await journal.load(identity);
    expect(loaded).toMatchObject({ kind: 'found', stored: { key, record } });
    if (loaded.kind !== 'found' || created.kind !== 'saved') return;
    expect((await journal.save(loaded.stored, { ...record, phase: 'admitting' })).kind).toBe('saved');
    // The stale revision loses.
    expect(await journal.save(loaded.stored, { ...record, phase: 'closed', closed: 'closed' })).toEqual({ kind: 'conflict' });
  });

  it('treats unreadable or foreign records as unavailable and never overwrites them', async () => {
    const backing = fakeControlStore();
    const journal = exchangeJournal(backing.store);
    const key = (await journal.key(identity))!;
    await backing.store.compareAndSet({ key, expectedRevision: null, operationId: 'x', next: { value: { v: 2 }, expiresAt: null } });
    expect(await journal.load(identity)).toEqual({ kind: 'unavailable' });
    expect(await journal.create(key, record)).toEqual({ kind: 'conflict' });
  });

  it('enforces phase invariants on decode', () => {
    expect(decodeRecord(record)).toEqual(record);
    expect(decodeRecord({ ...record, extra: 1 })).toBeNull();
    expect(decodeRecord({ ...record, phase: 'sealed' })).toBeNull();
    expect(decodeRecord({ ...record, phase: 'admitted' })).toBeNull();
    expect(decodeRecord({ ...record, phase: 'closed' })).toBeNull();
    expect(decodeRecord({ ...record, membership: 'joined' })).toBeNull();
    expect(decodeRecord({ ...record, closed: 'expired' })).toBeNull();
    expect(decodeRecord({ ...record, grant: 'cagrant_x' })).toBeNull();
  });

  it('pins one encryption key to one exchange record', async () => {
    const journal = exchangeJournal(fakeControlStore().store);
    const input = { recordKey: 'record_1', publicKey: 'k'.repeat(43), expiresAt: new Date(T0 + 60_000).toISOString() };
    expect(await journal.claimKey(input)).toBe('claimed');
    expect(await journal.claimKey(input)).toBe('claimed');
    expect(await journal.claimKey({ ...input, recordKey: 'record_2' })).toBe('key_reuse');
  });
});
