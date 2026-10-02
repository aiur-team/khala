import { expect, it } from 'vitest';
import { senderKindOf, toInboxEntry } from './sender';
import type { SessionMessage } from './matrix/session';
const message: SessionMessage = { eventId: '$1', roomId: '!r:s', sender: '@khala_abc:s', ts: 1790935500000, type: 'm.room.message', body: 'Hello', content: {} };
it.each([
  ['@khala_abc:s', null, 'khala_abc', 'human'],
  ['@agent-1a2b3c4d-x9y8z7:s', 'Codex · Maya', 'Codex · Maya', 'agent'],
  ['@bob:example.org', '@bob:example.org', 'bob', 'unknown'],
  ['@khala_abc:s', 'Maya', 'Maya', 'human'],
  ['@khala_abc:s', '', 'khala_abc', 'human'],
] as const)('maps sender %s with label %s', (sender, displayName, senderLabel, senderKind) => {
  expect(toInboxEntry({ ...message, sender }, displayName)).toEqual({ eventId: '$1', roomId: '!r:s', sender, senderLabel, senderKind, kind: 'message', body: 'Hello', ts: new Date(message.ts).toISOString() });
  expect(senderKindOf(sender)).toBe(senderKind);
});
it('converts Matrix milliseconds to ISO time', () => {
  expect(toInboxEntry(message).ts).toBe('2026-10-02T10:05:00.000Z');
});
