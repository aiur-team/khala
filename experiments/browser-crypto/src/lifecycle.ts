import { createClient, type MatrixClient } from 'matrix-js-sdk';
/** Hold a browser-wide exclusive lease before opening the SDK crypto store. */
export async function openDevice(): Promise<{ client: MatrixClient; close(): void }> {
  let unlock!: () => void;
  let resolve!: (value: { client: MatrixClient; close(): void }) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<{ client: MatrixClient; close(): void }>((yes, no) => { resolve = yes; reject = no; });
  void navigator.locks.request('khala-disposable-crypto-writer', { ifAvailable: true }, async lock => {
    if (!lock) { reject(new Error('crypto store already has a writer')); return; }
    const client = createClient({ baseUrl: location.origin, userId: '@proof:localhost', deviceId: 'DISPOSABLE' });
    try {
      await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: 'khala-proof' });
      const fingerprint = JSON.stringify(await client.getCrypto()!.getOwnDeviceKeys());
      const previous = localStorage.getItem('proof-fingerprint');
      if (previous && previous !== fingerprint) throw new Error('crypto store lost: old identity must not be reused');
      localStorage.setItem('proof-fingerprint', fingerprint);
      await new Promise<void>(done => {
        unlock = done;
        resolve({ client, close() { client.stopClient(); unlock(); } });
      });
    } catch (error) { client.stopClient(); reject(error); }
  }).catch(reject);
  return result;
}
