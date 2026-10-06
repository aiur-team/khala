import { afterEach, expect } from 'vitest';
import { decodeLocalMemberContent } from '@khala/contracts/m1/local';
import type { Decoded } from '@khala/contracts/messaging/decode';

const probes: { path: string; supported: boolean }[] = [];
afterEach(() => {
  for (const probe of probes.splice(0)) expect(probe.supported, `${probe.path} advertises wire=2 but cannot decode Gemini`).toBe(true);
});

/** Every advertised wire=2 capability must be supported by the actual response decoder. */
export function assertHarnessWireSupport(path: string, decode: (value: unknown) => Decoded<unknown>): void {
  const url = new URL(path, 'http://localhost');
  const user = '@agent-b2c3d4e5:local';
  const roomId = '!c7Kq2vXbT1nP0aZ9yW3eQw:local';
  const content = { user, membership: 'join', displayname: 'kevin-Gemini', kind: 'agent', harness: 'gemini' };
  const event = { seq: 1, eventId: '$' + 'a'.repeat(22), roomId, sender: user, ts: 1, type: 'm.room.member', content };
  const summary = { roomId, name: 'Channel', createdAt: '2026-10-05T00:00:00.000Z', lastSeq: 1, lastTs: 1,
    preview: null, members: [{ userId: user, displayName: 'kevin-Gemini', kind: 'agent', harness: 'gemini' }] };
  let payload: unknown;
  if (url.pathname.endsWith('/events')) payload = { events: [event], next: 1 };
  else if (url.pathname.endsWith('/messages')) {
    // History carries messages and rename pills, never raw membership events.
    probes.push({ path, supported: decodeLocalMemberContent(content).ok });
    payload = { events: [{ ...event, type: 'm.room.message', content: { msgtype: 'm.text', body: 'hello' } }] };
  }
  else if (url.pathname.endsWith('/members')) payload = { members: [{ userId: user, participantId: user,
    ownerId: 'local-owner', deviceId: 'KH_LOCAL_b2c3d4e5', displayName: 'kevin-Gemini', kind: 'agent', membership: 'join', harness: 'gemini' }] };
  else if (url.pathname === '/api/local/channels') payload = { revision: 1, channels: [summary] };
  else if (/\/channels\/[^/]+$/u.test(url.pathname)) payload = summary;
  else return;
  expect(url.searchParams.get('wire'), `${path} must request open harness wire`).toBe('2');
  probes.push({ path, supported: decode(payload).ok });
}
