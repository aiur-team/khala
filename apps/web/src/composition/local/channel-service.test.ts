import { describe, expect, it, vi } from 'vitest';
import { decodeContentLimits, type DeviceId, type DeviceView, type EventId, type RoomId } from '@khala/contracts/messaging/index';
import { createMemoryChannelJournal, type ChannelSubstrate } from '@khala/messaging/channels/index';
import { createLocalHttp } from './http';
import { createLocalSession, LOCAL_PRINCIPAL } from './session';
import { createLocalChannelService } from './channel-service';

const decoded = decodeContentLimits({ maxBodyBytes: 256, maxDisplayNameBytes: 64, maxRoomTitleBytes: 64 });
if (!decoded.ok) throw new Error('invalid test limits');
const limits = decoded.value;
const roomId = '!channel:local' as RoomId;
const request = { roomId, clientTxnId: 'txn-1', content: { v: 1, kind: 'text', body: 'hello' } } as const;

function setup() {
  const session = createLocalSession(createLocalHttp({ origin: 'http://localhost:47830', fetch: vi.fn() }));
  session.noteUsername('kevin');
  const releaseSubstrate = vi.fn();
  const substrate: ChannelSubstrate = {
    createRoom: vi.fn(async () => ({ kind: 'unavailable' as const })),
    findCreatedRoom: vi.fn(async () => ({ kind: 'absent' as const })),
    room: vi.fn(async () => ({ kind: 'done' as const, value: { roomId, title: 'Channel', membership: 'joined' as const, revision: '1' } })),
    sendEvent: vi.fn(async () => ({ kind: 'done' as const, value: { eventId: '$message' as EventId, authorDeviceId: 'KH_LOCAL_OWNER' as DeviceId } })),
    timeline: vi.fn(async () => ({ kind: 'done' as const, value: { events: [], nextCursor: null, revision: '1' } })),
    subscribe: vi.fn(() => releaseSubstrate),
  };
  const releaseViewing = vi.fn();
  const onObserve = vi.fn(() => releaseViewing);
  const journal = vi.fn(() => createMemoryChannelJournal());
  const service = createLocalChannelService({
    principal: LOCAL_PRINCIPAL, actor: session.participant, device: session.device,
    substrate, limits, journal, onObserve,
  });
  const ready = () => session.device.ensureReady(LOCAL_PRINCIPAL.ownerId);
  return { service, session, substrate, releaseSubstrate, releaseViewing, onObserve, journal, ready };
}

describe('local channel service', () => {
  it('waits for device readiness, then delegates sends to the shared service', async () => {
    const { service, substrate, ready, journal } = setup();
    expect(await service.room.send(request)).toEqual({ kind: 'unavailable', retryable: true });
    expect(journal).not.toHaveBeenCalled();
    expect(substrate.sendEvent).not.toHaveBeenCalled();
    await ready();
    expect((await service.room.send(request)).kind).toBe('ok');
    expect(substrate.sendEvent).toHaveBeenCalledExactlyOnceWith(request, undefined);
    expect(journal).toHaveBeenCalledExactlyOnceWith(LOCAL_PRINCIPAL.ownerId);
    service.dispose();
  });

  it.each(['observe', 'observeEntries'] as const)('releases %s and the viewing marker exactly once', async method => {
    const { service, ready, substrate, onObserve, releaseViewing, releaseSubstrate } = setup();
    const early = service.room[method](roomId, () => {});
    early();
    expect(onObserve).not.toHaveBeenCalled();
    await ready();
    const dispose = service.room[method](roomId, () => {});
    expect(onObserve).toHaveBeenCalledExactlyOnceWith(roomId);
    expect(substrate.subscribe).toHaveBeenCalledTimes(1);
    dispose(); dispose();
    expect(releaseViewing).toHaveBeenCalledTimes(1);
    expect(releaseSubstrate).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('observes notification entries without acknowledging unread messages', async () => {
    const { service, ready, substrate, onObserve, releaseSubstrate } = setup();
    await ready();
    const background = service.observeBackgroundEntries(roomId, () => {});
    expect(onObserve).not.toHaveBeenCalled();
    expect(substrate.subscribe).toHaveBeenCalledOnce();
    const foreground = service.room.observeEntries(roomId, () => {});
    expect(onObserve).toHaveBeenCalledExactlyOnceWith(roomId);
    expect(substrate.subscribe).toHaveBeenCalledOnce();
    foreground();
    expect(releaseSubstrate).not.toHaveBeenCalled();
    background();
    expect(releaseSubstrate).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('rebuilds after device stop even when generation stays one and retains the journal', async () => {
    const { service, ready, session, substrate, releaseSubstrate, journal } = setup();
    await ready();
    const first = service.room.observeEntries(roomId, () => {});
    await session.device.stop();
    expect(releaseSubstrate).toHaveBeenCalledTimes(1);
    expect(await service.room.send(request)).toEqual({ kind: 'unavailable', retryable: true });
    await ready();
    expect(session.device.current().generation).toBe(1);
    const second = service.room.observeEntries(roomId, () => {});
    expect(substrate.subscribe).toHaveBeenCalledTimes(2);
    expect(journal).toHaveBeenCalledTimes(1);
    expect((await service.room.send(request)).kind).toBe('ok');
    first(); second(); service.dispose();
  });

  it('rebuilds on a ready generation change and on explicit stop', async () => {
    const { service, ready, session, substrate, releaseSubstrate, journal } = setup();
    await ready();
    service.room.observeEntries(roomId, () => {});
    const view = session.device.current();
    vi.spyOn(session.device, 'current').mockImplementation((): DeviceView => ({ ...view, generation: 2 }));
    service.room.observeEntries(roomId, () => {});
    expect(releaseSubstrate).toHaveBeenCalledTimes(1);
    expect(substrate.subscribe).toHaveBeenCalledTimes(2);
    service.stop();
    service.room.observeEntries(roomId, () => {});
    expect(substrate.subscribe).toHaveBeenCalledTimes(3);
    expect(journal).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('requires an actor and permanently removes the lifecycle observer on dispose', async () => {
    const { session, substrate, ready, journal } = setup();
    const removeObserver = vi.fn();
    vi.spyOn(session.device, 'observe').mockReturnValue(removeObserver);
    let actor = false;
    const service = createLocalChannelService({ principal: LOCAL_PRINCIPAL, actor: () => actor ? session.participant() : null,
      device: session.device, substrate, limits, journal });
    await ready();
    expect(await service.room.send(request)).toEqual({ kind: 'unavailable', retryable: true });
    actor = true;
    service.room.observeEntries(roomId, () => {});
    service.dispose(); service.dispose();
    expect(removeObserver).toHaveBeenCalledTimes(1);
    expect(await service.room.send(request)).toEqual({ kind: 'unavailable', retryable: true });
  });
});
