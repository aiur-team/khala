import { afterEach, expect, it, vi } from 'vitest';
import { ClientEvent, SyncState, createClient, type MatrixClient } from 'matrix-js-sdk';
import { createBrowserDeviceService, type BrowserDeviceDependencies } from '@khala/messaging/browser-device/index';
import { createMatrixBrowserPorts } from './matrix-browser';

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
  const client = {
    initRustCrypto: vi.fn(async () => {}), getCrypto: () => crypto,
    getUserId: () => '@bob:test', stopClient: vi.fn(),
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
  await vi.advanceTimersByTimeAsync(0);
  expect(bootstrapCrossSigning).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(vi.getTimerCount()).toBe(0);
  await engine.close();
});
