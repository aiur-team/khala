import { afterEach, expect, it, vi } from 'vitest';
import { ClientEvent, SyncState, createClient, type MatrixClient } from 'matrix-js-sdk';
import { createBrowserDeviceService, type BrowserDeviceDependencies } from '@khala/messaging/browser-device/index';
import { createMatrixBrowserPorts } from './matrix-browser';
import { guardedListeningModeSetter } from './listening-modes';

vi.mock('matrix-js-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('matrix-js-sdk')>(), createClient: vi.fn(),
}));
vi.mock('@khala/messaging/browser-device/index', async importOriginal => ({
  ...await importOriginal<typeof import('@khala/messaging/browser-device/index')>(),
  createBrowserDeviceService: vi.fn(() => ({ current: () => ({ state: 'ready', generation: 1 }) })),
}));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('opens locally and completes device start while cross-signing bootstrap never resolves', async () => {
  vi.useFakeTimers();
  const bootstrapCrossSigning = vi.fn(() => new Promise<void>(() => {}));
  const crypto = {
    getOwnDeviceKeys: vi.fn(async () => ({ ed25519: 'fingerprint' })),
    getCrossSigningStatus: vi.fn(async () => ({ privateKeysCachedLocally: {} })),
    userHasCrossSigningKeys: vi.fn(async () => false), bootstrapCrossSigning,
  };
  let synced: ((state: SyncState) => void) | undefined;
  let membership = 'join';
  const roomId = '!room:test' as never;
  const sendEvent = vi.fn(async () => ({ event_id: '$mode' }));
  const client = {
    initRustCrypto: vi.fn(async () => {}), getCrypto: () => crypto,
    getUserId: () => '@bob:test', stopClient: vi.fn(),
    getRoom: (id: string) => id === roomId ? { getMyMembership: () => membership, hasEncryptionStateEvent: () => true } : null,
    sendEvent,
    on: vi.fn((event, listener) => { if (event === ClientEvent.Sync) synced = listener; }),
    off: vi.fn(), startClient: vi.fn(async () => { synced?.(SyncState.Prepared); }),
  } as unknown as MatrixClient;
  vi.mocked(createClient).mockReturnValue(client);
  const principal = { ownerId: 'bob', verifiedEmail: 'bob@test' } as never;
  const ports = createMatrixBrowserPorts({ identity: {} as never, credentials: {
    resolve: vi.fn(async () => ({ kind: 'unavailable' as const })),
  }, limits: {} as never, participants: {
    resolve: vi.fn(async () => new Map([['@bob:test', { participantId: 'bob', kind: 'human', ownerId: 'bob', displayName: 'Bob', deviceIds: [] } as never]])),
  } });
  expect(ports.isJoined(roomId)).toBe(false);
  const deps = vi.mocked(createBrowserDeviceService).mock.calls[0]![0] as BrowserDeviceDependencies;
  const signal = new AbortController().signal;
  await deps.credentials.resolve(principal, signal);
  const opening = deps.engines.open({ ownerId: 'bob' as never, session: {
    deviceId: 'BOB' as never, publishedFingerprint: null,
    credentials: { homeserverOrigin: 'https://test', userId: '@bob:test', accessToken: 'token' },
  }, store: { name: 'bob', close: async () => {} }, signal, emit: vi.fn() });
  let opened = false;
  void opening.then(() => { opened = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(opened).toBe(true);
  expect(crypto.getCrossSigningStatus).not.toHaveBeenCalled();
  const engine = await opening;
  await expect(engine.identity()).resolves.toEqual({ fingerprint: 'fingerprint', created: false });
  await expect(engine.start(signal)).resolves.toBeUndefined();
  expect(ports.participant()).toMatchObject({ participantId: 'bob' });
  // No timeline has loaded: owner commands use current SDK membership.
  expect(ports.isJoined(roomId)).toBe(true);
  expect(ports.isJoined('!unknown:test' as never)).toBe(false);
  const setMode = guardedListeningModeSetter({ roomId, viewer: ports.participant()!, ownerOf: () => 'bob',
    joined: () => ports.isJoined(roomId), matrixUserId: () => '@agent:test', send: ports.setListeningMode });
  await expect(setMode('agent', 'async')).resolves.toBe('sent');
  expect(sendEvent).toHaveBeenCalledOnce();
  for (const next of ['leave', 'ban', 'invite']) {
    membership = next;
    await expect(setMode('agent', 'steer')).resolves.toBe('failed');
  }
  expect(sendEvent).toHaveBeenCalledOnce();
  membership = 'join';
  await vi.advanceTimersByTimeAsync(0);
  expect(bootstrapCrossSigning).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(vi.getTimerCount()).toBe(0);
  await engine.close();
  expect(ports.isJoined(roomId)).toBe(false);
});

it('reports the Live sync state from client sync events, scoped to the active owner and generation', async () => {
  const listeners = new Set<(state: SyncState) => void>();
  let state: SyncState | null = null;
  const emit = (next: SyncState) => { state = next; for (const listener of [...listeners]) listener(next); };
  const client = {
    initRustCrypto: vi.fn(async () => {}), stopClient: vi.fn(), getUserId: () => '@bob:test',
    getCrypto: () => ({ getOwnDeviceKeys: vi.fn(async () => ({ ed25519: 'fingerprint' })),
      getCrossSigningStatus: vi.fn(async () => ({ privateKeysCachedLocally: { masterKey: true } })),
      userHasCrossSigningKeys: vi.fn(async () => true) }),
    getSyncState: () => state,
    on: vi.fn((event, listener) => { if (event === ClientEvent.Sync) listeners.add(listener); }),
    off: vi.fn((event, listener) => { if (event === ClientEvent.Sync) listeners.delete(listener); }),
    startClient: vi.fn(async () => { emit(SyncState.Prepared); }),
  } as unknown as MatrixClient;
  vi.mocked(createClient).mockReturnValue(client);
  const ports = createMatrixBrowserPorts({ identity: {} as never, credentials: {
    resolve: vi.fn(async () => ({ kind: 'unavailable' as const })),
  }, limits: {} as never, participants: {
    resolve: vi.fn(async () => new Map([['@bob:test', { participantId: 'bob', kind: 'human', ownerId: 'bob', displayName: 'Bob', deviceIds: [] } as never]])),
  } });
  const bob = 'bob' as never;
  expect(ports.syncStatus.live(bob, 1)).toBe(false);
  const deps = vi.mocked(createBrowserDeviceService).mock.calls[0]![0] as BrowserDeviceDependencies;
  const signal = new AbortController().signal;
  await deps.credentials.resolve({ ownerId: 'bob', verifiedEmail: 'bob@test' } as never, signal);
  const engine = await deps.engines.open({ ownerId: bob, session: {
    deviceId: 'BOB' as never, publishedFingerprint: null,
    credentials: { homeserverOrigin: 'https://test', userId: '@bob:test', accessToken: 'token' },
  }, store: { name: 'bob', close: async () => {} }, signal, emit: vi.fn() });
  await engine.start(signal);

  expect(ports.syncStatus.live(bob, 1)).toBe(true);
  expect(ports.syncStatus.live(bob, 2)).toBe(false);
  expect(ports.syncStatus.live('alice' as never, 1)).toBe(false);
  const listener = vi.fn();
  const dispose = ports.syncStatus.subscribe(bob, 1, listener);
  emit(SyncState.Reconnecting);
  expect(listener).toHaveBeenCalledOnce();
  expect(ports.syncStatus.live(bob, 1)).toBe(false);
  emit(SyncState.Syncing);
  expect(ports.syncStatus.live(bob, 1)).toBe(true);
  dispose();
  emit(SyncState.Error);
  expect(listener).toHaveBeenCalledTimes(2);
  await engine.close();
});
