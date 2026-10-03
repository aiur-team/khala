import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeContentLimits, type RoomId } from '@khala/contracts/messaging/index';
import type { createLocalChannelService } from './channel-service';
import type { createLocalSubstrate } from './substrate';
import type { LocalConversations } from './conversations';
import { LOCAL_PRINCIPAL } from './session';
import { localAdmission } from './links';
import { createLocalHumanPorts, localInitialPath } from './ports';

const captured = vi.hoisted(() => ({
  channel: null as Parameters<typeof createLocalChannelService>[0] | null,
  substrate: null as Parameters<typeof createLocalSubstrate>[0] | null,
  room: {}, dispose: vi.fn(),
}));
vi.mock('./channel-service', () => ({ createLocalChannelService: vi.fn(input => {
  captured.channel = input;
  return { room: captured.room, stop: vi.fn(), dispose: captured.dispose };
}) }));
vi.mock('./substrate', () => ({ createLocalSubstrate: vi.fn(input => {
  captured.substrate = input;
  return {};
}) }));
const origin = 'http://127.0.0.1:47830';
const roomId = '!c7Kq2vXbT1nP0aZ9yW3eQw:local' as RoomId;
const agent = '@agent-a1b2c3d4:local';
const decoded = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
if (!decoded.ok) throw new Error('invalid test limits');
const limits = decoded.value;
const profile = { userId: '@khala_owner:local', ownerId: 'local-owner', username: 'kevin', suggestion: 'kevin', color: 'teal', initials: null };
function setup() {
  const calls: { url: string; method: string; headers: Headers; body: unknown; signal: AbortSignal | null | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal });
    let body: unknown;
    if (path === '/api/local/profile') body = profile;
    else if (path === '/api/local/profile/username') body = { username: 'kev' };
    else if (path.endsWith('/mode')) body = { eventId: '$q3Zp0bE8yS1m4Vt7nC2aRw' };
    else if (path === '/api/local/channels') {
      // First page loads; the next request behaves like a held helper long-poll.
      if (calls.filter(c => new URL(c.url).pathname === path).length > 1) {
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
      body = { revision: 1, channels: [] };
    } else throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const ports = createLocalHumanPorts({ origin, limits, fetch });
  return { ports, calls };
}
const active: ReturnType<typeof setup>['ports'][] = [];
beforeEach(() => { vi.useFakeTimers(); captured.dispose.mockReset(); });
afterEach(() => { for (const ports of active.splice(0)) ports.dispose(); vi.useRealTimers(); });
describe('local composition', () => {
  it.each([
    ['/', '', '/conversations'], ['/', '?x=1', '/conversations'], ['/new', '?code=1', '/new'],
    ['/conversations', '?mount=hosted-content', '/conversations'],
    ['/channels/!c7Kq2vXbT1nP0aZ9yW3eQw%3Alocal', '', '/channels/!c7Kq2vXbT1nP0aZ9yW3eQw%3Alocal'],
  ])('canonicalizes %s%s', (pathname, search, expected) => expect(localInitialPath({ pathname, search })).toBe(expected));

  it('shares the local session, cache and conversations with the channel service', async () => {
    const { ports } = setup(); active.push(ports);
    expect('agentJoin' in ports).toBe(false); expect('inviteAgent' in ports).toBe(false);
    expect(ports.admission).toBe(localAdmission); expect(ports.room).toBe(captured.room);
    expect(ports.syncStatus).toBe((ports.conversations as LocalConversations).syncStatus);
    expect(captured.substrate!.http.origin).toBe(origin);
    expect(captured.substrate!.generation()).toBe(1);
    expect(captured.substrate!.members.describe).toBeTypeOf('function');
    expect(captured.channel!.principal).toBe(LOCAL_PRINCIPAL);
    expect(captured.channel!.device).toBe(ports.device);
    expect(captured.channel!.actor()).toBeNull(); expect(ports.participant!()).toBeNull();
    expect(await ports.identity.current()).toEqual({ kind: 'signed_in', principal: LOCAL_PRINCIPAL });
    expect(captured.channel!.actor()).toEqual(ports.participant!());
    expect(ports.participant!()?.displayName).toBe('kevin');
    const viewing = vi.spyOn(ports.conversations as LocalConversations, 'viewing');
    const release = captured.channel!.onObserve!(roomId);
    expect(viewing).toHaveBeenCalledExactlyOnceWith(roomId); expect(release).toBeTypeOf('function'); release();
    const describe = vi.spyOn(captured.substrate!.members, 'describe');
    ports.describeParticipant!('someone'); expect(describe).toHaveBeenCalledWith('someone');
    expect(await ports.profile!.setUsername('kev')).toEqual({ kind: 'ok', username: 'kev' });
    expect(ports.participant!()?.displayName).toBe('kev');
  });
  it('wires mode commands to the same members cache with guarded HTTP', async () => {
    const { ports, calls } = setup(); active.push(ports);
    expect(ports.listeningMode!(roomId, agent)).toBe('sync');
    expect(await ports.setListeningMode!(roomId, agent, 'async', 'txn_9')).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${origin}/api/local/channels/${encodeURIComponent(roomId)}/mode`);
    expect(calls[0]!.method).toBe('POST'); expect(calls[0]!.headers.get('x-khala-local')).toBe('1');
    expect(calls[0]!.body).toEqual({ agent, mode: 'async', txnId: 'txn_9' });
  });
  it('disposes once, aborting the conversations poll and stopping the device', async () => {
    const { ports, calls } = setup(); active.push(ports);
    await ports.device.ensureReady(LOCAL_PRINCIPAL.ownerId);
    ports.conversations!.snapshot(LOCAL_PRINCIPAL.ownerId, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    ports.dispose(); ports.dispose();
    expect(captured.dispose).toHaveBeenCalledTimes(1);
    expect(calls[1]!.signal?.aborted).toBe(true);
    expect(ports.device.current().state).toBe('new');
    await vi.advanceTimersByTimeAsync(30_000); expect(calls).toHaveLength(2);
  });
  it('continues cleanup if channel disposal throws', async () => {
    const { ports, calls } = setup(); active.push(ports);
    await ports.device.ensureReady(LOCAL_PRINCIPAL.ownerId);
    ports.conversations!.snapshot(LOCAL_PRINCIPAL.ownerId, 1);
    await vi.advanceTimersByTimeAsync(0);
    captured.dispose.mockImplementationOnce(() => { throw new Error('cleanup'); });
    expect(() => ports.dispose()).not.toThrow();
    expect(calls[1]!.signal?.aborted).toBe(true); expect(ports.device.current().state).toBe('new');
  });
});
