import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientEvent, SyncState } from 'matrix-js-sdk';

const fake = vi.hoisted(() => ({ client: null as unknown, created: 0 }));
vi.mock('matrix-js-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('matrix-js-sdk')>(),
  createClient: () => { fake.created += 1; return fake.client; },
}));

type BrowserApi = {
  open(input: Record<string, string>): Promise<unknown>;
  trustPeer(userId: string, deviceId: string, fingerprint: string): Promise<void>;
  read(cursor: string | null, limit: number): Promise<unknown>;
  send(clientTxnId: string, body: string): Promise<unknown>;
  close(): Promise<void>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { khalaMatrix?: BrowserApi }).khalaMatrix;
  vi.resetModules();
});

const openInput = { baseUrl: 'https://matrix.example', userId: '@agent:example',
  deviceId: 'AGENT_DEVICE', accessToken: 'test-token', roomId: '!room:example', storeName: 'test' };

async function openedBrowser(fingerprints: Array<string | null>, rollbackFails = false) {
  fake.created = 0;
  const listeners = new Map<string, Set<(state: SyncState) => void>>();
  const published = [...fingerprints];
  let verified = false;
  const getUserDeviceInfo = vi.fn(async () => {
    const fingerprint = published.length > 1 ? published.shift() : published[0];
    return new Map([['@owner:example', new Map(fingerprint === null ? []
      : [['OWNER_DEVICE', { getFingerprint: () => fingerprint }]])]]);
  });
  const setDeviceVerified = vi.fn(async (_userId: string, _deviceId: string, value: boolean) => {
    if (!value && rollbackFails) throw new Error('sdk_rollback_failed');
    verified = value;
  });
  const setTrustCrossSignedDevices = vi.fn();
  const stopClient = vi.fn();
  const crypto = {
    getOwnDeviceKeys: async () => ({ ed25519: 'connector-key' }),
    getUserDeviceInfo,
    setDeviceVerified,
    setTrustCrossSignedDevices,
    getDeviceVerificationStatus: async () => ({ isVerified: () => verified }),
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
    stopClient,
  };
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown,
    callback: (lock: object) => Promise<void>) => callback({}) } });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); } });
  await import('./browser');
  const api = (globalThis as unknown as { khalaMatrix: BrowserApi }).khalaMatrix;
  await api.open(openInput);
  return { api, getUserDeviceInfo, setDeviceVerified, setTrustCrossSignedDevices,
    getDeviceVerificationStatus: crypto.getDeviceVerificationStatus, storage, stopClient };
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

  it('leaves a swapped owner device unverified after the SDK verification call', async () => {
    const { api, setDeviceVerified, setTrustCrossSignedDevices, getDeviceVerificationStatus, storage } =
      await openedBrowser(['owner-key', 'attacker-key']);
    try {
      expect(setTrustCrossSignedDevices).toHaveBeenCalledExactlyOnceWith(false);
      await expect(api.trustPeer('@owner:example', 'OWNER_DEVICE', 'owner-key'))
        .rejects.toThrow('matrix_fingerprint_mismatch');
      expect(setDeviceVerified.mock.calls).toEqual([
        ['@owner:example', 'OWNER_DEVICE', true],
        ['@owner:example', 'OWNER_DEVICE', false],
      ]);
      expect((await getDeviceVerificationStatus()).isVerified()).toBe(false);
      expect(storage.has('khala-matrix-trust-pending:test')).toBe(false);
    } finally { await api.close(); }
  });

  it('quarantines the persisted store and active API when rollback fails', async () => {
    const { api, storage, stopClient, getDeviceVerificationStatus } =
      await openedBrowser(['owner-key', 'attacker-key'], true);
    try {
      await expect(api.trustPeer('@owner:example', 'OWNER_DEVICE', 'owner-key'))
        .rejects.toThrow('matrix_verification_rollback_failed');
      expect((await getDeviceVerificationStatus()).isVerified()).toBe(true);
      expect(storage.get('khala-matrix-trust-pending:test')).toBe('1');
      await expect(api.read(null, 1)).rejects.toThrow('matrix_trust_compromised');
      await expect(api.send('txn123456', 'secret')).rejects.toThrow('matrix_trust_compromised');
      expect(stopClient).toHaveBeenCalled();
      await api.close();
      vi.resetModules();
      await import('./browser');
      const restartedApi = (globalThis as unknown as { khalaMatrix: BrowserApi }).khalaMatrix;
      await expect(restartedApi.open(openInput)).rejects.toThrow('matrix_trust_recovery_required');
      expect(fake.created).toBe(1);
    } finally { await api.close(); }
  });
});
