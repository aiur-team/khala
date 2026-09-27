import { describe, expect, it, vi } from 'vitest';
import { CLOSURE_CONSEQUENCES, ok, type AuthPrincipal, type ClosurePort, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { createGateway } from '../runtime/handler';
import { CLOSURE_PATH, createChannelClosureHandlers } from './handler';

const origin = 'https://khala.aiur.team';
const principal: AuthPrincipal = {
  v: 1, ownerId: 'owner_alice' as OwnerId, providerIssuer: 'https://issuer.example', providerSubject: 'alice',
  verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z',
};
const command = { operationId: 'close_1', ownerId: principal.ownerId, roomId: 'room_1' as RoomId, expectedRoomRevision: 0 };

function setup() {
  const cleanupRequests = vi.fn(async () => ({ kind: 'ok' as const, requests: [command] }));
  const service: ClosurePort = {
    capability: vi.fn(async roomId => ok({ ownerId: principal.ownerId, roomId, expectedRoomRevision: 0,
      available: true, unavailableReason: null, consequences: CLOSURE_CONSEQUENCES })),
    closeRoom: vi.fn(async input => ok({ operationId: input.operationId, state: 'partial' as const, reason: 'local_cleanup_failed' as const })),
    inspectClosure: vi.fn(async operationId => ok({ operationId, state: 'partial' as const, reason: 'local_cleanup_failed' as const })),
  };
  const auth = {
    authenticateRequest: vi.fn(async () => ({ kind: 'authenticated' as const, context: { principal, csrfToken: 'csrf' } })),
    requireHumanMutation: vi.fn(async () => ({ kind: 'authorized' as const, context: { principal, csrfToken: 'csrf' } })),
  };
  const registrations = createChannelClosureHandlers({ auth, service: () => service, cleanupRequests });
  const gateway = createGateway({ registrations, absentPrefixes: [], appOrigin: origin });
  return { auth, service, cleanupRequests, gateway };
}

function post(input: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}${CLOSURE_PATH}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
}

describe('protected closure route', () => {
  it('exposes durable cleanup requests only to the authenticated owner browser', async () => {
    const { auth, cleanupRequests, gateway } = setup();
    const url = `${origin}${CLOSURE_PATH}?cleanup=1`;
    vi.mocked(auth.authenticateRequest).mockResolvedValueOnce({ kind: 'rejected', code: 'signed_out' } as never);
    expect((await gateway(new Request(url))).status).toBe(401);
    expect(cleanupRequests).not.toHaveBeenCalled();
    const response = await gateway(new Request(url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'ok', value: [command] });
    expect(cleanupRequests).toHaveBeenCalledWith(principal);
    vi.mocked(auth.authenticateRequest).mockResolvedValueOnce({ kind: 'rejected', code: 'signed_out' } as never);
    expect((await gateway(new Request(url, { headers: { authorization: 'DPoP agent-token' } }))).status).toBe(401);
    expect(cleanupRequests).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await (await gateway(new Request(url))).json())).not.toMatch(/secret|matrixAccessToken|body/);
    expect((await gateway(new Request(`${origin}${CLOSURE_PATH}?cleanup=1&roomId=room_1`))).status).toBe(400);
  });

  it('requires human mutation authority before parsing or invoking closure', async () => {
    const { auth, service, gateway } = setup();
    vi.mocked(auth.requireHumanMutation).mockResolvedValueOnce({ kind: 'rejected', code: 'csrf_mismatch' } as never);
    const denied = await gateway(post(command));
    expect(denied.status).toBe(403);
    expect(service.closeRoom).not.toHaveBeenCalled();
    const foreign = await gateway(post({ ...command, ownerId: 'owner_bob' }));
    expect(foreign.status).toBe(403);
    expect(service.closeRoom).not.toHaveBeenCalled();
    const forged = await gateway(post(command, { origin: 'https://attacker.example' }));
    expect(forged.status).toBe(403);
    expect(auth.requireHumanMutation).toHaveBeenCalledTimes(2);
  });

  it('passes only a validated owner/channel/generation command and preserves partial status', async () => {
    const { gateway, service } = setup();
    const response = await gateway(post(command));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'ok', value: { operationId: 'close_1', state: 'partial', reason: 'local_cleanup_failed' } });
    expect(service.closeRoom).toHaveBeenCalledWith(command);
    expect((await gateway(post({ ...command, extra: true }))).status).toBe(400);
  });
});
