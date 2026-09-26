// Local replacements for the hosted human ports. Identity is the session the
// launcher bootstrapped, the device is the fixed local human device, the
// channel port is the ordinary channel service over the loopback substrate,
// and admission is closed: internal channels have no share or join flow.

import {
  rejected,
  unavailable,
  type AdmissionPort,
  type AuthPrincipal,
  type ContentLimits,
  type DevicePort,
  type DeviceView,
  type IdentityPort,
  type ParticipantView,
  type RoomPort,
} from '@khala/contracts/messaging/index';
import { createChannelService, type ChannelService } from '@khala/messaging/channels/index';
import {
  REQUEST_SECRET_STORAGE_KEY, createHttpRoomSubstrate, type HttpRoomSubstrate, type LocalHuman,
} from '@khala/messaging/local/http/index';
import { createBrowserRoomJournal } from '../../composition/human/room-journal';

/** The local device never re-initialises within one page, so its lifecycle generation is fixed. */
export const LOCAL_DEVICE_GENERATION = 1;

/** Present only to satisfy `AuthPrincipal`; never displayed and never an identity key. */
const SYNTHETIC_EMAIL = 'owner@internal.invalid';
const FAR_FUTURE = '9999-12-31T23:59:59Z';

export type LocalPorts = Readonly<{
  identity: IdentityPort;
  device: DevicePort;
  room: RoomPort;
  admission: AdmissionPort;
  limits: ContentLimits;
  participant: () => ParticipantView | null;
  substrate: HttpRoomSubstrate;
  dispose(): void;
}>;

export type LocalPortsOptions = Readonly<{
  origin: string;
  requestSecret: string;
  limits: ContentLimits;
  fetch?: typeof globalThis.fetch;
  /** Injected for tests; defaults to the persistent browser journal. */
  journal?: Parameters<typeof createChannelService>[0]['journal'];
}>;

/** The request secret the bootstrap script left for this tab, or `null` when the page was not bootstrapped. */
export function readRequestSecret(storage: Pick<Storage, 'getItem'> | null = globalThis.sessionStorage ?? null): string | null {
  try {
    return storage?.getItem(REQUEST_SECRET_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function localPrincipal(human: LocalHuman): AuthPrincipal {
  return {
    v: 1,
    ownerId: human.ownerId,
    providerIssuer: 'khala-internal',
    providerSubject: human.ownerId,
    verifiedEmail: SYNTHETIC_EMAIL,
    sessionExpiresAt: FAR_FUTURE,
  };
}

/** The signed-in human as the timeline's viewer; server events carry the stored display name. */
export function localViewer(human: LocalHuman): ParticipantView {
  return { participantId: human.participantId, kind: 'human', ownerId: human.ownerId, displayName: 'You', deviceIds: [human.deviceId] };
}

/** Admission is closed locally: every share, inspect and admit is refused before any request. */
export const closedAdmission: AdmissionPort = {
  share: async () => rejected('forbidden'),
  inspect: async () => 'unavailable',
  admit: async () => rejected('forbidden'),
};

export function createLocalPorts(options: LocalPortsOptions): LocalPorts {
  let human: LocalHuman | null = null;
  const substrate = createHttpRoomSubstrate({
    origin: options.origin,
    requestSecret: options.requestSecret,
    limits: options.limits,
    generation: () => LOCAL_DEVICE_GENERATION,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const identity: IdentityPort = {
    async current(callOptions) {
      if (human !== null && substrate.transport.current().kind !== 'auth_failed') {
        return { kind: 'signed_in', principal: localPrincipal(human) };
      }
      const session = await substrate.session(callOptions);
      if (session.kind === 'auth_failed') return { kind: 'signed_out' };
      if (session.kind === 'unavailable') return { kind: 'unavailable', retryable: true };
      // One page holds exactly one session; a different human is never adopted.
      if (human !== null && human.participantId !== session.human.participantId) return { kind: 'unavailable', retryable: true };
      human = session.human;
      return { kind: 'signed_in', principal: localPrincipal(human) };
    },
    // There is no sign-in or sign-out locally; a new session comes only from a relaunch.
    beginSignIn: async () => rejected('invalid_return_path'),
    signOut: async () => unavailable(),
  };

  const notReady: DeviceView = { deviceId: null, state: 'new', generation: LOCAL_DEVICE_GENERATION, reason: null };
  const readyView = (): DeviceView => (human === null
    ? notReady
    : { deviceId: human.deviceId, state: 'ready', generation: LOCAL_DEVICE_GENERATION, reason: null });

  const device: DevicePort = {
    async ensureReady(ownerId) {
      if (human === null) return unavailable();
      if (ownerId !== human.ownerId) return rejected('owner_mismatch');
      return { kind: 'ok', value: readyView() };
    },
    current: readyView,
    observe: () => () => undefined,
    async stop() {},
  };

  let service: ChannelService | null = null;
  function channels(): ChannelService | null {
    if (human === null) return null;
    service ??= createChannelService({
      principal: localPrincipal(human),
      actor: localViewer(human),
      device,
      substrate,
      journal: options.journal ?? createBrowserRoomJournal(human.ownerId),
      limits: options.limits,
    });
    return service;
  }

  const room: RoomPort = {
    create: (value, callOptions) => channels()?.create(value, callOptions) ?? Promise.resolve(unavailable()),
    prepareIntro: (value, callOptions) => channels()?.prepareIntro(value, callOptions) ?? Promise.resolve(unavailable()),
    resumeIntro: (value, callOptions) => channels()?.resumeIntro(value, callOptions) ?? Promise.resolve(unavailable()),
    send: (value, callOptions) => channels()?.send(value, callOptions) ?? Promise.resolve(unavailable()),
    timeline: (value, callOptions) => channels()?.timeline(value, callOptions) ?? Promise.resolve(unavailable()),
    observe: (roomId, listener) => channels()?.observe(roomId, listener) ?? (() => undefined),
  };

  return {
    identity,
    device,
    room,
    admission: closedAdmission,
    limits: options.limits,
    participant: () => (human === null ? null : localViewer(human)),
    substrate,
    dispose() {
      service?.stop();
      substrate.close();
    },
  };
}
