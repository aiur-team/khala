import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientEvent, SyncState } from 'matrix-js-sdk';

const fake = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('matrix-js-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('matrix-js-sdk')>(),
  createClient: () => fake.client,
}));

type BrowserApi = {
  open(input: Record<string, string>): Promise<unknown>;
  trustPeer(userId: string, deviceId: string, fingerprint: string): Promise<void>;
  close(): Promise<void>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { khalaMatrix?: BrowserApi }).khalaMatrix;
});

async function openedBrowser(fingerprints: Array<string | null>) {
  const listeners = new Map<string, Set<(state: SyncState) => void>>();
  const published = [...fingerprints];
  const getUserDeviceInfo = vi.fn(async () => {
    const fingerprint = published.length > 1 ? published.shift() : published[0];
    return new Map([['@owner:example', new Map(fingerprint === null ? []
      : [['OWNER_DEVICE', { getFingerprint: () => fingerprint }]])]]);
  });
  const setDeviceVerified = vi.fn(async () => undefined);
  const crypto = {
    getOwnDeviceKeys: async () => ({ ed25519: 'connector-key' }),
    getUserDeviceInfo,
    setDeviceVerified,
    getDeviceVerificationStatus: async () => ({ isVerified: () => true }),
    forceDiscardSession: async () => undefined,
  };
  fake.client = {
    initRustCrypto: async () => undefined,
    getCrypto: () => crypto,
    on: (event: string, listener: (state: SyncState) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event: string, listener: (state: SyncState) => void) => listeners.get(event)?.delete(listener),
    startClient: async () => {
      for (const listener of listeners.get(ClientEvent.Sync) ?? []) listener(SyncState.Prepared);
    },
    stopClient: () => undefined,
  };
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown,
    callback: (lock: object) => Promise<void>) => callback({}) } });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); } });
  await import('./browser');
  const api = (globalThis as unknown as { khalaMatrix: BrowserApi }).khalaMatrix;
  await api.open({ baseUrl: 'https://matrix.example', userId: '@agent:example',
    deviceId: 'AGENT_DEVICE', accessToken: 'test-token', roomId: '!room:example', storeName: 'test' });
  return { api, getUserDeviceInfo, setDeviceVerified };
}

describe('connector browser device trust', () => {
  it('waits for the pinned owner key and refuses a different published key', async () => {
    const { api, getUserDeviceInfo, setDeviceVerified } = await openedBrowser([null, 'owner-key']);
    try {
      await api.trustPeer('@owner:example', 'OWNER_DEVICE', 'owner-key');
      expect(getUserDeviceInfo).toHaveBeenCalledTimes(3);
      expect(setDeviceVerified).toHaveBeenCalledExactlyOnceWith('@owner:example', 'OWNER_DEVICE', true);
      await expect(api.trustPeer('@owner:example', 'OWNER_DEVICE', 'wrong-key'))
        .rejects.toThrow('matrix_fingerprint_mismatch');
      expect(setDeviceVerified).toHaveBeenCalledTimes(1);
    } finally { await api.close(); }
  });
});
