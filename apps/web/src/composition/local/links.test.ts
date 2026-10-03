import { describe, expect, it, vi } from 'vitest';
import { decodeRoomId } from '@khala/contracts/messaging/ids';
import { createLocalHttp, type LocalHttp } from './http';
import { createLocalChannelLinks, localAdmission } from './links';

const room = decodeRoomId('!c7Kq2vXbT1nP0aZ9yW3eQw:local');
if (!room.ok) throw new Error('fixture room');
const roomId = room.value;
const shareLink = 'http://127.0.0.1:47830/join/AbCdEfGh12345678901234567890123456789012345';
const expiresAt = '2025-10-02T09:10:00.000Z';
function setup(payload: unknown = { shareLink, expiresAt }) {
  const get = vi.fn<LocalHttp['get']>();
  const send = vi.fn<LocalHttp['send']>().mockImplementation(async (...args) => {
    const decode = args[3];
    const decoded = decode(payload);
    return decoded.ok ? { kind: 'ok', value: decoded.value } : { kind: 'error', status: 200, code: 'invalid_response' };
  });
  return { get, send, links: createLocalChannelLinks({ origin: 'http://localhost:47830', get: get as LocalHttp['get'], send: send as LocalHttp['send'] }) };
}
describe('local channel links', () => {
  it('preserves the canonical link even when the page origin is localhost', async () => {
    const { links, send } = setup(); const signal = new AbortController().signal;
    expect(await links.personal(roomId, signal)).toEqual({ v: 1, kind: 'personal_link', shareUrl: shareLink, expiresAt });
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/local/channels/!c7Kq2vXbT1nP0aZ9yW3eQw%3Alocal/links',
      {}, expect.any(Function), signal);
    await links.personal(roomId); expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(['http://example.com/join/abc', 'http://127.0.0.1:47830/open/abc',
    'http://127.0.0.1:47830/join/abc?q=1', 'http://127.0.0.1:47830/join/abc#x'])('rejects invalid link %s', async link => {
    expect(await setup({ shareLink: link, expiresAt }).links.personal(roomId)).toEqual({ v: 1, kind: 'unavailable' });
  });
  it.each([[401, 'auth_required'], [403, 'forbidden'], [500, 'unavailable']])('maps HTTP %s to %s', async (status, kind) => {
    const { links, send } = setup(); send.mockResolvedValue({ kind: 'error', status, code: 'error' });
    expect(await links.personal(roomId)).toEqual({ v: 1, kind });
  });
  it('handles unavailable and rejected transport and malformed success bodies', async () => {
    const { links, send } = setup(); send.mockResolvedValue({ kind: 'unavailable' });
    expect(await links.personal(roomId)).toEqual({ v: 1, kind: 'unavailable' });
    send.mockRejectedValue(new Error('transport'));
    expect(await links.personal(roomId)).toEqual({ v: 1, kind: 'unavailable' });
    expect(await setup({ shareLink, expiresAt, extra: true }).links.personal(roomId)).toEqual({ v: 1, kind: 'unavailable' });
  });
  it('returns unavailable resolution and admission without making requests', async () => {
    const { links, get, send } = setup();
    expect(await links.resolve(shareLink)).toEqual({ v: 1, kind: 'unavailable' });
    expect(await localAdmission.share({ operationId: 'op', roomId })).toEqual({ kind: 'unavailable', retryable: true });
    expect(await localAdmission.inspect('ref')).toBe('unavailable');
    const { decodeDeviceId } = await import('@khala/contracts/messaging/ids');
    const device = decodeDeviceId('KH_LOCAL_OWNER'); if (!device.ok) throw new Error('device');
    expect(await localAdmission.admit({ operationId: 'op', inviteRef: 'ref', deviceId: device.value }))
      .toEqual({ kind: 'unavailable', retryable: true });
    expect(get).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('sends link mutations through the real guarded HTTP client', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ shareLink, expiresAt }),
      { headers: { 'content-type': 'application/json' } }));
    const links = createLocalChannelLinks(createLocalHttp({ origin: 'http://localhost:47830', fetch }));
    expect(await links.personal(roomId)).toMatchObject({ kind: 'personal_link', shareUrl: shareLink });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/links'), expect.objectContaining({ method: 'POST', body: '{}',
      headers: expect.objectContaining({ 'x-khala-local': '1' }), credentials: 'same-origin' }));
  });
});
