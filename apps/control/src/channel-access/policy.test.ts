import { describe, expect, it } from 'vitest';
import {
  CHANNEL_ACCESS_COOLDOWN_MS,
  CHANNEL_ACCESS_DEADLINE_MS,
  CHANNEL_ACCESS_OWNER_MAX,
  CHANNEL_ACCESS_PURGE_MS,
  CHANNEL_ACCESS_REQUESTER_MAX,
  createChannelAccessPolicy,
} from './policy';

const key = new Uint8Array(32).fill(7);

describe('channel-access policy', () => {
  it('pins the contract ceilings and accepts lower-only limits', () => {
    expect(CHANNEL_ACCESS_REQUESTER_MAX).toBe(5);
    expect(CHANNEL_ACCESS_OWNER_MAX).toBe(50);
    expect(CHANNEL_ACCESS_COOLDOWN_MS).toBe(5 * 60_000);
    expect(CHANNEL_ACCESS_DEADLINE_MS).toBe(7 * 24 * 60 * 60_000);
    expect(CHANNEL_ACCESS_PURGE_MS).toBe(30 * 24 * 60 * 60_000);

    expect(createChannelAccessPolicy({ key, requesterMax: 1, ownerMax: 2 }).limits)
      .toEqual({ requesterMax: 1, ownerMax: 2 });
  });

  it.each([
    { requesterMax: 0 },
    { requesterMax: 6 },
    { ownerMax: 0 },
    { ownerMax: 51 },
    { requesterMax: 1.5 },
  ])('rejects unsafe limit override %#', override => {
    expect(() => createChannelAccessPolicy({ key, ...override })).toThrow(/channel-access limit/);
  });

  it('copies key material and purpose-separates every durable locator', () => {
    const mutable = new Uint8Array(key);
    const policy = createChannelAccessPolicy({ key: mutable });
    const fields = {
      requester: 'principal_1',
      sessionFingerprint: 'session-fingerprint',
      sessionGeneration: 3,
      origin: 'https://khala.example',
      kind: 'access' as const,
      operationId: 'operation_1',
      ownerId: 'owner_1',
      targetFingerprint: 'target-fingerprint',
    };
    const before = policy.derive(fields);
    mutable.fill(9);
    expect(policy.derive(fields)).toEqual(before);

    const values = Object.values(before);
    expect(new Set(values).size).toBe(values.length);
    expect(before.requestHandle).toMatch(/^careq_[A-Za-z0-9_-]{43}$/);
    expect(values.every(value => !value.includes(fields.requester))).toBe(true);
    expect(values.every(value => !value.includes(fields.origin))).toBe(true);
  });

  it('binds the operation to requester, session, origin, kind, owner and first target', () => {
    const policy = createChannelAccessPolicy({ key });
    const base = {
      requester: 'principal_1',
      sessionFingerprint: 'session-fingerprint',
      sessionGeneration: 3,
      origin: 'https://khala.example',
      kind: 'access' as const,
      operationId: 'operation_1',
      ownerId: 'owner_1',
      targetFingerprint: 'target-fingerprint',
    };
    const first = policy.derive(base);
    const replacements = {
      requester: 'principal_2',
      sessionFingerprint: 'other-session',
      sessionGeneration: 4,
      origin: 'https://other.example',
      kind: 'create' as const,
      operationId: 'operation_2',
      ownerId: 'owner_2',
      targetFingerprint: 'other-target',
    };
    for (const [field, value] of Object.entries(replacements)) {
      expect(policy.derive({ ...base, [field]: value }).bindingDigest).not.toBe(first.bindingDigest);
    }
    expect(policy.derive({ ...base, targetFingerprint: 'other-target' }).operationKey)
      .toBe(first.operationKey);
  });
});
