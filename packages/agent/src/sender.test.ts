import { expect, it } from 'vitest';
import { senderKindOf, toInboxEntry, withReplyContext } from './sender';
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
it('prefixes replies with their parent for khala_read, leaving other messages and the contract shape alone', () => {
  const reply = (eventId: string, body: string, parent: string) => toInboxEntry({ ...message, eventId, body,
    content: { msgtype: 'm.text', body, 'm.relates_to': { 'm.in_reply_to': { event_id: parent } } } }, 'Kevin');
  const parent = toInboxEntry({ ...message, body: 'Ship\nit today?' }, 'Maya');
  const [first, near, far] = withReplyContext([parent, reply('$2', 'Yes', '$1'), reply('$3', 'And?', '$gone')]);
  expect(first).toBe(parent);
  expect(near!.body).toBe('↪ reply to Maya: Ship it today?\nYes');
  expect(far!.body).toBe('↪ reply to an earlier message\nAnd?');
  expect(Object.keys(near!).sort()).toEqual(Object.keys(parent).sort());
});
