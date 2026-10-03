import {
  type AuthPrincipal, type ContentLimits, type DevicePort, type Disposer, type OwnerId,
  type ParticipantView, type RoomId, type RoomPort, unavailable,
} from '@khala/contracts/messaging/index';
import {
  createChannelService, type ChannelJournal, type ChannelService, type ChannelSubstrate,
} from '@khala/messaging/channels/index';
import { createBrowserRoomJournal } from '../human/room-journal';

export type LocalChannelService = Readonly<{
  room: RoomPort & Pick<ChannelService, 'observeEntries'>;
  /** Stops the current service; a later ready device builds a fresh one. */
  stop(): void;
  /** Stops the service and removes the device observer. */
  dispose(): void;
}>;

export function createLocalChannelService(input: Readonly<{
  principal: AuthPrincipal;
  actor: () => ParticipantView | null;
  device: DevicePort;
  substrate: ChannelSubstrate;
  limits: ContentLimits;
  journal?: (ownerId: OwnerId) => ChannelJournal;
  onObserve?: (roomId: RoomId) => Disposer;
}>): LocalChannelService {
  let current: { generation: number; service: ChannelService } | null = null;
  let journal: ChannelJournal | null = null;
  let disposed = false;

  function stop(): void {
    current?.service.stop();
    current = null;
  }

  function service(): ChannelService | null {
    const view = input.device.current();
    const actor = input.actor();
    if (disposed || view.state !== 'ready' || view.deviceId === null || actor === null) return null;
    if (current?.generation === view.generation) return current.service;
    stop();
    const next = createChannelService({
      principal: input.principal, actor, device: input.device, substrate: input.substrate,
      journal: journal ??= (input.journal ?? createBrowserRoomJournal)(input.principal.ownerId),
      limits: input.limits,
    });
    current = { generation: view.generation, service: next };
    return next;
  }

  function observe(roomId: RoomId, register: (service: ChannelService) => Disposer): Disposer {
    const active = service();
    if (!active) return () => {};
    const release = input.onObserve?.(roomId);
    const stopObserving = register(active);
    let observing = true;
    return () => {
      if (!observing) return;
      observing = false;
      try { stopObserving(); } finally { release?.(); }
    };
  }

  const removeDeviceObserver = input.device.observe(view => {
    if (view.state !== 'ready') stop();
  });

  return {
    room: {
      create: (value, options) => service()?.create(value, options) ?? Promise.resolve(unavailable()),
      prepareIntro: (value, options) => service()?.prepareIntro(value, options) ?? Promise.resolve(unavailable()),
      resumeIntro: (value, options) => service()?.resumeIntro(value, options) ?? Promise.resolve(unavailable()),
      send: (value, options) => service()?.send(value, options) ?? Promise.resolve(unavailable()),
      timeline: (value, options) => service()?.timeline(value, options) ?? Promise.resolve(unavailable()),
      observe: (roomId, listener) => observe(roomId, active => active.observe(roomId, listener)),
      observeEntries: (roomId, listener) => observe(roomId, active => active.observeEntries(roomId, listener)),
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      removeDeviceObserver();
    },
  };
}
