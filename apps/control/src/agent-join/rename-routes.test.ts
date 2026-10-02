import { expect, it, vi } from 'vitest';
import { agentOwnerRecordKey } from '@khala/contracts/m1/participants';
import { nameKey } from '@khala/contracts/m1/names';
import type { AuthPrincipal, JsonValue, OwnerId } from '@khala/contracts/messaging/index';
import type { MutationAuthorization } from '../auth/index';
import { createControlStore } from '../runtime/control-store';
import { durableStores } from './testing/store';
import { AGENT_RENAME_PATH, createAgentRenameHandler } from './rename-routes';

const matrixUserId = '@agent:matrix.test';
async function fixture() {
  const clock = () => Date.parse('2026-10-02T12:00:00.000Z');
  const blobs = durableStores();
  const store = createControlStore({ records: blobs.storeFor('records'), operations: blobs.storeFor('operations'), clock });
  let sequence = 0;
  const put = async (key: string, value: JsonValue) => {
    expect((await store.compareAndSet({ key, expectedRevision: null, operationId: `seed-${++sequence}`,
      next: { value, expiresAt: null } })).kind).toBe('applied');
  };
  await put(agentOwnerRecordKey(matrixUserId), { matrixUserId, ownerId: 'owner', ownerLabel: 'Kevin', harness: 'claude',
    label: 'Kevin-Claude', createdAt: new Date(clock()).toISOString() });
  const principal = { ownerId: 'owner' as OwnerId, verifiedEmail: 'kevin@x' } as AuthPrincipal;
  const auth = { requireHumanMutation: vi.fn(async (request: Request): Promise<MutationAuthorization> =>
    request.headers.get('x-khala-csrf') !== 'csrf' ? { kind: 'rejected', code: 'csrf_mismatch' }
      : { kind: 'authorized', context: { principal, csrfToken: 'csrf' } }) };
  const provisioner = { setDisplayName: vi.fn(async () => true) };
  const request = (body: unknown = { matrixUserId, name: 'Reviewer' }, csrf = true) => new Request(`https://khala.test${AGENT_RENAME_PATH}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-khala-csrf': 'csrf' } : {}) }, body: JSON.stringify(body) });
  return { store, put, auth, provisioner, request, handler: createAgentRenameHandler({ store, clock, auth, provisioner }) };
}
it('renames through the authenticated mutation route', async () => {
  const f = await fixture(); const response = await f.handler(f.request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ matrixUserId, name: 'Reviewer' });
  expect(f.provisioner.setDisplayName).toHaveBeenCalledWith(matrixUserId, 'Reviewer');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('requires CSRF before reading request data or modifying the agent', async () => {
  const f = await fixture(); const response = await f.handler(f.request({ extra: true }, false));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'csrf_mismatch' });
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
});
it.each(['signed_out', 'forbidden_origin', 'csrf_mismatch', 'not_a_mutation'] as const)('maps authorization rejection %s', async code => {
  const f = await fixture(); f.auth.requireHumanMutation.mockResolvedValue({ kind: 'rejected', code });
  const response = await f.handler(f.request());
  expect(response.status).toBe(code === 'signed_out' ? 401 : code === 'not_a_mutation' ? 405 : 403);
  expect(await response.json()).toEqual({ error: code === 'not_a_mutation' ? 'method_not_allowed' : code });
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
});
it('maps unavailable authorization and refuses non-POST requests', async () => {
  const f = await fixture(); f.auth.requireHumanMutation.mockResolvedValue({ kind: 'unavailable' });
  expect((await f.handler(f.request())).status).toBe(503);
  f.auth.requireHumanMutation.mockClear();
  expect((await f.handler(new Request(`https://khala.test${AGENT_RENAME_PATH}`))).status).toBe(405);
  expect(f.auth.requireHumanMutation).not.toHaveBeenCalled();
});
it.each([
  null, {}, { matrixUserId }, { matrixUserId, name: 'Reviewer', extra: true },
  { matrixUserId: 'agent', name: 'Reviewer' }, { matrixUserId, name: 42 },
])('rejects nonexact or malformed request %j', async body => {
  const f = await fixture(); const response = await f.handler(f.request(body));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request' });
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
});
it('rejects invalid JSON and provides the finite name-validation reason', async () => {
  const f = await fixture();
  const request = new Request(`https://khala.test${AGENT_RENAME_PATH}`, { method: 'POST', headers: { 'x-khala-csrf': 'csrf' }, body: '{' });
  expect(await (await f.handler(request)).json()).toEqual({ error: 'invalid_request' });
  const response = await f.handler(f.request({ matrixUserId, name: 'ab cd' }));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_name', reason: 'invalid_characters' });
});
it('maps agent absence, ownership, namespace conflicts and Matrix failures', async () => {
  const missing = await fixture(); const absent = await missing.handler(missing.request({ matrixUserId: '@missing:matrix.test', name: 'Reviewer' }));
  expect(absent.status).toBe(404); expect(await absent.json()).toEqual({ error: 'not_found' });
  const foreign = await fixture(); foreign.auth.requireHumanMutation.mockResolvedValue({ kind: 'authorized',
    context: { principal: { ownerId: 'other' as OwnerId } as AuthPrincipal, csrfToken: 'csrf' } });
  const refused = await foreign.handler(foreign.request());
  expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ error: 'not_owner' });
  expect(foreign.provisioner.setDisplayName).not.toHaveBeenCalled();
  const taken = await fixture(); await taken.put(nameKey('Reviewer'), { v: 1, kind: 'human', ownerId: 'other' });
  const conflict = await taken.handler(taken.request());
  expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: 'name_taken' });
  const offline = await fixture(); offline.provisioner.setDisplayName.mockResolvedValue(false);
  const unavailable = await offline.handler(offline.request());
  expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ error: 'unavailable' });
});
