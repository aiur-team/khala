import { describe, expect, it, vi } from 'vitest';
import { createLocalHttp } from './http';
import { createLocalAgentNamesPort } from './agent-names';
const origin = 'http://127.0.0.1:47830';
const userId = '@agent-a1b2c3d4:local';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, port: createLocalAgentNamesPort(createLocalHttp({ origin, fetch })) };
};
describe('local agent names', () => {
  it('renames the requested agent with an encoded path and name-only body', async () => {
    const { fetch, port } = setup(); fetch.mockResolvedValue(json(200, { matrixUserId: userId, name: 'Reviewer' }));
    expect(await port.rename(userId, 'Reviewer')).toEqual({ kind: 'ok', name: 'Reviewer' });
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/local/agents/%40agent-a1b2c3d4%3Alocal/name`, expect.objectContaining({ method: 'POST', body: '{"name":"Reviewer"}', headers: expect.objectContaining({ 'x-khala-local': '1' }) }));
  });
  it.each([
    [400, { error: 'invalid_name', reason: 'reserved' }, { kind: 'error', code: 'invalid_name', reason: 'reserved' }],
    [400, { error: 'invalid_name', reason: 'invented' }, { kind: 'error', code: 'invalid_name' }],
    [400, { error: 'invalid_request' }, { kind: 'error', code: 'unavailable' }],
    [403, { error: 'not_owner' }, { kind: 'error', code: 'not_owner' }],
    [403, { error: 'forbidden_origin' }, { kind: 'error', code: 'unavailable' }],
    [404, { error: 'not_found' }, { kind: 'error', code: 'not_found' }],
    [404, { error: 'other' }, { kind: 'error', code: 'unavailable' }],
    [409, { error: 'name_taken' }, { kind: 'error', code: 'name_taken' }],
    [409, { error: 'other' }, { kind: 'error', code: 'unavailable' }],
    [401, {}, { kind: 'error', code: 'signed_out' }],
    [503, {}, { kind: 'error', code: 'unavailable' }],
    [200, { matrixUserId: '@agent-deadbeef:local', name: 'Reviewer' }, { kind: 'error', code: 'unavailable' }],
    [200, { matrixUserId: userId, name: ' Reviewer ' }, { kind: 'error', code: 'unavailable' }],
  ])('maps rename response %s %j', async (status, body, expected) => {
    const { fetch, port } = setup(); fetch.mockResolvedValue(json(status, body));
    expect(await port.rename(userId, 'Reviewer')).toEqual(expected);
  });
  it('maps network failures', async () => {
    const { fetch, port } = setup(); fetch.mockRejectedValue(new Error('offline'));
    expect(await port.rename(userId, 'Reviewer')).toEqual({ kind: 'error', code: 'unavailable' });
  });
});
