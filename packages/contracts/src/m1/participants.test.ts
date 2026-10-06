import { expect, it } from 'vitest';
import { agentOwnerRecordKey, decodeAgentOwnerRecord, decodeParticipant, decodeParticipantsResponse, humanEmailRecordKey, ownerFirstName } from './participants';

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
  expect(decodeParticipant({ ...agent, harness: 'Bad' }).ok).toBe(false);
  expect(decodeParticipant({ ...human, displayName: 'a\nb' }).ok).toBe(false);
  expect(decodeParticipant({ kind: 'other' }).ok).toBe(false);
  expect(decodeParticipant(null).ok).toBe(false);
});
it('decodes owner records with nonempty owner labels and valid agent labels', () => {
  expect(decodeAgentOwnerRecord(record)).toEqual({ ok: true, value: record });
  for (const patch of [{ ownerLabel: '' }, { label: ' Claude' }, { harness: 'Bad' }, { createdAt: '2026-02-30T00:00:00Z' }, { extra: true }]) expect(decodeAgentOwnerRecord({ ...record, ...patch }).ok).toBe(false);
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
  expect(decodeParticipantsResponse({ participants: [human, { ...agent, harness: 'Bad' }] })).toEqual({ ok: false, error: { path: 'participants[1].harness', code: 'invalid_value' } });
  expect(decodeParticipantsResponse({ participants: [] })).toEqual({ ok: true, value: { participants: [] } });
  expect(decodeParticipantsResponse({ participants: 'bad' }).ok).toBe(false);
  expect(decodeParticipantsResponse({ participants: [], extra: true }).ok).toBe(false);
});
it('decodes an optional verified email on human participants only', () => {
  const withEmail = { ...human, email: 'kevin.weaver2@gmail.com' };
  expect(decodeParticipant(withEmail)).toEqual({ ok: true, value: withEmail });
  expect(decodeParticipantsResponse({ participants: [withEmail, agent] })).toEqual({ ok: true, value: { participants: [withEmail, agent] } });
  expect(decodeParticipant({ ...human, email: 'not-an-email' })).toEqual({ ok: false, error: { path: 'email', code: 'invalid_value' } });
  expect(decodeParticipant({ ...human, email: '' }).ok).toBe(false);
  expect(decodeParticipant({ ...agent, email: 'kevin@example.com' })).toEqual({ ok: false, error: { path: 'email', code: 'unknown_field' } });
  expect(decodeParticipant({ ...unknown, email: 'kevin@example.com' }).ok).toBe(false);
  expect(humanEmailRecordKey('own_a/b')).toBe('humans/own_a%2Fb/email');
});

it('accepts optional human and owner colours and rejects invalid or misplaced colours', () => {
  for (const value of [human, agent, { ...human, color: 'pink' }, { ...agent, ownerColor: 'teal' }]) {
    expect(decodeParticipant(value)).toEqual({ ok: true, value });
  }
  expect(decodeParticipant({ ...human, color: 'chartreuse' }).ok).toBe(false);
  expect(decodeParticipant({ ...agent, ownerColor: 'chartreuse' }).ok).toBe(false);
  expect(decodeParticipant({ ...human, ownerColor: 'pink' }).ok).toBe(false);
  expect(decodeParticipant({ ...agent, color: 'pink' }).ok).toBe(false);
});

it('accepts canonical chosen initials only on the appropriate participant kind', () => {
  for (const value of [{ ...human, initials: 'É1' }, { ...agent, ownerInitials: 'KW' }]) {
    expect(decodeParticipant(value)).toEqual({ ok: true, value });
  }
  for (const initials of ['kw', null, 'K', 'ßa']) {
    expect(decodeParticipant({ ...human, initials }).ok).toBe(false);
    expect(decodeParticipant({ ...agent, ownerInitials: initials }).ok).toBe(false);
  }
  for (const value of [{ ...human, ownerInitials: 'KW' }, { ...agent, initials: 'KW' }, { ...unknown, initials: 'KW' }, { ...unknown, ownerInitials: 'KW' }]) {
    expect(decodeParticipant(value).ok).toBe(false);
  }
  expect(decodeParticipantsResponse({ participants: [{ ...human, initials: 'kw' }] })).toEqual({ ok: false, error: { path: 'participants[0].initials', code: 'invalid_value' } });
});

it('decodes Muse in participants and owner records', () => {
  expect(decodeParticipantsResponse({ participants: [{ ...agent, harness: 'muse' }] })).toMatchObject({ ok: true });
  expect(decodeAgentOwnerRecord({ ...record, harness: 'muse' })).toMatchObject({ ok: true });
});
