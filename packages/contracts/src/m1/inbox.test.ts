import { expect, it } from 'vitest';
import { type InboxEntry, decodeInboxEntry, decodeInboxLine, encodeInboxLine, INBOX_BODY_MAX_BYTES } from './inbox';

const entry: InboxEntry = { eventId: '$event', roomId: '!v12room', ts: '2026-10-01T00:00:00Z', sender: '@maya:khala.local', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: 'first\nsecond\t🌟' };
it('round trips JSONL while preserving plaintext newlines', () => {
  const line = encodeInboxLine(entry);
  expect(line).toBe(JSON.stringify(entry) + '\n');
  expect(line.split('\n')).toHaveLength(2);
  expect(decodeInboxLine(line)).toEqual({ ok: true, value: entry });
});
it('accepts all sender kinds and both entry kinds', () => {
  for (const senderKind of ['human', 'agent', 'unknown'] as const) for (const kind of ['message', 'event'] as const) {
    const value = { ...entry, senderKind, kind };
    expect(decodeInboxEntry(value)).toEqual({ ok: true, value });
  }
});
it('enforces exact keys and validates every field', () => {
  for (const key of Object.keys(entry)) {
    const missing = { ...entry } as Record<string, unknown>;
    delete missing[key];
    expect(decodeInboxEntry(missing)).toEqual({ ok: false, error: { path: key, code: 'missing_field' } });
    expect(decodeInboxEntry({ ...entry, [key]: 1 }).ok).toBe(false);
  }
  expect(decodeInboxEntry({ ...entry, extra: true })).toEqual({ ok: false, error: { path: 'extra', code: 'unknown_field' } });
  for (const patch of [{ eventId: 'event' }, { eventId: '$has space' }, { roomId: 'room' }, { sender: '@no-server' }, { senderLabel: 'a\nb' }, { ts: '2026-02-30T00:00:00Z' }, { senderKind: 'other' }, { kind: 'other' }, { body: '\u0000' }, { body: '\ud800' }]) expect(decodeInboxEntry({ ...entry, ...patch }).ok).toBe(false);
});
it('enforces UTF-8 body and label boundaries', () => {
  expect(decodeInboxEntry({ ...entry, body: 'é'.repeat(INBOX_BODY_MAX_BYTES / 2), senderLabel: 'é'.repeat(256) }).ok).toBe(true);
  expect(decodeInboxEntry({ ...entry, body: 'é'.repeat(INBOX_BODY_MAX_BYTES / 2) + 'a' })).toEqual({ ok: false, error: { path: 'body', code: 'too_long' } });
  expect(decodeInboxEntry({ ...entry, senderLabel: 'é'.repeat(257) }).ok).toBe(false);
  expect(decodeInboxEntry({ ...entry, body: '', senderLabel: '' }).ok).toBe(true);
});
it('reports malformed JSON and invalid decoded shapes', () => {
  for (const line of ['', '{', 'undefined', '{}\n{}']) expect(decodeInboxLine(line)).toEqual({ ok: false, error: { path: '', code: 'invalid_value' } });
  expect(decodeInboxLine('null')).toEqual({ ok: false, error: { path: '', code: 'not_object' } });
  expect(decodeInboxLine('{}').ok).toBe(false);
});
