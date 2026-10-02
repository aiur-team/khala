import { expect, it } from 'vitest';
import { agentOwnerRecordKey, decodeAgentOwnerRecord, decodeParticipant, decodeParticipantsResponse, ownerFirstName } from './participants';

const human = { matrixUserId: '@human:khala.local', participantId: 'human_123', ownerId: 'owner_kevin', displayName: 'Kevin', kind: 'human' };
const agent = { ...human, matrixUserId: '@agent:khala.local', kind: 'agent', displayName: 'Claude · Kevin', ownerLabel: 'Kevin', harness: 'claude' };
const unknown = { matrixUserId: '@unknown:khala.local', displayName: '@unknown:khala.local', kind: 'unknown' };
const record = { matrixUserId: agent.matrixUserId, ownerId: human.ownerId, ownerLabel: 'Kevin', harness: 'claude', label: 'Claude', createdAt: '2026-10-01T00:00:00Z' };

it.each([['kevin.weaver2@gmail.com', 'Kevin'], ['maya_2@example.com', 'Maya'], ['john123-other@example.com', 'John'], ['keVin+tag', 'KeVin'], ['123@example.com', 'Owner'], ['.name@example.com', 'Owner'], ['', 'Owner'], ['a@b@c', 'A@b']])('derives owner first name from %s', (email, expected) => expect(ownerFirstName(email)).toBe(expected));
it('encodes the full user id in the owner record key', () => expect(agentOwnerRecordKey('@agent:khala.local')).toBe('agents/%40agent%3Akhala.local'));
it('decodes every participant kind and a mixed response without rewriting labels', () => {
  for (const value of [human, agent, unknown]) expect(decodeParticipant(value)).toEqual({ ok: true, value });
  const value = { participants: [human, agent, unknown] };
  expect(decodeParticipantsResponse(value)).toEqual({ ok: true, value });
  expect(decodeParticipant({ ...human, displayName: '' }).ok).toBe(true);
});
it('enforces each variant exact keys', () => {
  for (const value of [human, agent, unknown]) {
    expect(decodeParticipant({ ...value, extra: true })).toEqual({ ok: false, error: { path: 'extra', code: 'unknown_field' } });
    const missing: Record<string, unknown> = { ...value };
    delete missing['displayName'];
    expect(decodeParticipant(missing)).toEqual({ ok: false, error: { path: 'displayName', code: 'missing_field' } });
  }
  expect(decodeParticipant({ ...unknown, ownerId: 'owner' }).ok).toBe(false);
  expect(decodeParticipant({ ...human, harness: 'claude' }).ok).toBe(false);
  expect(decodeParticipant({ ...agent, harness: 'bad' }).ok).toBe(false);
  expect(decodeParticipant({ ...human, displayName: 'a\nb' }).ok).toBe(false);
  expect(decodeParticipant({ kind: 'other' }).ok).toBe(false);
  expect(decodeParticipant(null).ok).toBe(false);
});
it('decodes owner records with nonempty owner labels and valid agent labels', () => {
  expect(decodeAgentOwnerRecord(record)).toEqual({ ok: true, value: record });
  for (const patch of [{ ownerLabel: '' }, { label: ' Claude' }, { harness: 'bad' }, { createdAt: '2026-02-30T00:00:00Z' }, { extra: true }]) expect(decodeAgentOwnerRecord({ ...record, ...patch }).ok).toBe(false);
  expect(decodeAgentOwnerRecord({}).ok).toBe(false);
});
it('enforces byte limits on display and owner labels', () => {
  expect(decodeParticipant({ ...agent, displayName: 'é'.repeat(256), ownerLabel: 'é'.repeat(256) }).ok).toBe(true);
  expect(decodeParticipant({ ...human, displayName: 'é'.repeat(257) }).ok).toBe(false);
  expect(decodeParticipant({ ...agent, ownerLabel: 'é'.repeat(257) }).ok).toBe(false);
});
it('bounds lists, rejects duplicates and preserves element error paths', () => {
  const participants = Array.from({ length: 100 }, (_, index) => ({ ...unknown, matrixUserId: `@user${index}:khala.local` }));
  expect(decodeParticipantsResponse({ participants }).ok).toBe(true);
  expect(decodeParticipantsResponse({ participants: [...participants, human] })).toEqual({ ok: false, error: { path: 'participants', code: 'too_long' } });
  expect(decodeParticipantsResponse({ participants: [human, human] })).toEqual({ ok: false, error: { path: 'participants[1]', code: 'duplicate' } });
  expect(decodeParticipantsResponse({ participants: [human, { ...agent, harness: 'bad' }] })).toEqual({ ok: false, error: { path: 'participants[1].harness', code: 'invalid_value' } });
  expect(decodeParticipantsResponse({ participants: [] })).toEqual({ ok: true, value: { participants: [] } });
  expect(decodeParticipantsResponse({ participants: 'bad' }).ok).toBe(false);
  expect(decodeParticipantsResponse({ participants: [], extra: true }).ok).toBe(false);
});
