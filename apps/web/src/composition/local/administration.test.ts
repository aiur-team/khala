import { assertHarnessWireSupport } from './fixtures/wire-harness';
import { expect, it } from 'vitest';
import { LOCAL_OWNER_ID } from '@khala/contracts/m1/local';
import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { LocalHttp } from './http';
import { createLocalAdministration } from './administration';

const roomId = '!c7Kq2vXbT1nP0aZ9yW3eQw:local' as RoomId;
const http: LocalHttp = {
  origin: 'http://127.0.0.1:47830',
  get: async (path, decode) => {
    assertHarnessWireSupport(path, decode);
    const value = decode({ roomId, name: 'Channel', createdAt: '2026-10-05T00:00:00.000Z', lastSeq: 1, lastTs: 1, preview: null, members: [] });
    return value.ok ? { kind: 'ok', value: value.value } : { kind: 'unavailable' };
  },
  send: async () => { throw new Error('Local has only its creator; never send a removal.'); },
};
it('identifies the single local human as creator after checking the channel', async () => {
  expect(await createLocalAdministration(http).creator(roomId)).toEqual({ kind: 'ok', value: LOCAL_OWNER_ID });
});
it('does not label nonexistent or unavailable local channels', async () => {
  expect(await createLocalAdministration({ ...http, get: async () => ({ kind: 'error', status: 404, code: 'not_found' }) }).creator(roomId))
    .toEqual({ kind: 'rejected', code: 'not_found' });
  expect(await createLocalAdministration({ ...http, get: async () => ({ kind: 'unavailable' }) }).creator(roomId))
    .toEqual({ kind: 'unavailable', retryable: true });
});
it('rejects self-removal and unknown humans without touching agents', async () => {
  const port = createLocalAdministration(http);
  expect(await port.removeHuman({ roomId, ownerId: LOCAL_OWNER_ID as OwnerId })).toEqual({ kind: 'rejected', code: 'forbidden' });
  expect(await port.removeHuman({ roomId, ownerId: 'other' as OwnerId })).toEqual({ kind: 'rejected', code: 'not_found' });
});
