import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, CompareAndSetInput, ControlRecord, ControlStore, JsonValue, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../../apps/control/src/auth/index';
import { createOwnerCleanupRequests } from '../../../apps/control/src/channel-closure/cleanup-requests';
import { CLOSURE_PATH, createChannelClosureHandlers } from '../../../apps/control/src/channel-closure/handler';
import { mintCanary } from './fixtures';

function memoryStore(): ControlStore {
  const records = new Map<string, ControlRecord>();
  let revision = 0;
  return {
    async read<T extends JsonValue>(key: string) {
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const current = records.get(input.key);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict' as const, current: current as ControlRecord<T> | undefined ?? null };
      }
      const record: ControlRecord<T> = { key: input.key, revision: `r${++revision}`, operationId: input.operationId,
        value: structuredClone(input.next.value), expiresAt: input.next.expiresAt };
      records.set(input.key, record);
      return { kind: 'applied' as const, record };
    },
    async resolve() { return { kind: 'not_applied' as const }; },
  };
}

describe('owner cleanup discovery boundary', () => {
  it('keeps a post-leave request readable only by the exact owner and contains no message content', async () => {
    const owner = { ownerId: 'owner_cleanup' as OwnerId, providerIssuer: 'https://issuer.example',
      providerSubject: 'owner-subject', verifiedEmail: 'owner@example.test',
      sessionExpiresAt: '2030-01-01T00:00:00Z' } as AuthPrincipal;
    const peer = { ...owner, ownerId: 'peer_owner' as OwnerId, providerSubject: 'peer-subject' };
    const request = { operationId: 'close_cleanup_1', ownerId: owner.ownerId,
      roomId: '!cleanup:example' as RoomId, expectedRoomRevision: 0 };
    const store = memoryStore();
    expect(await createOwnerCleanupRequests(store, owner.ownerId).record(request)).toBe('requested');
    const canary = mintCanary('pending');
    const auth = { async authenticateRequest(input: Request) {
      const cookie = input.headers.get('cookie');
      return cookie === 'session=owner' ? { kind: 'authenticated', context: { principal: owner } }
        : cookie === 'session=peer' ? { kind: 'authenticated', context: { principal: peer } }
          : { kind: 'signed_out' };
    } } as unknown as AuthService;
    const handler = createChannelClosureHandlers({ auth,
      service: () => { throw new Error('cleanup discovery must not query active Matrix membership'); },
      cleanupRequests: principal => createOwnerCleanupRequests(store, principal.ownerId).list(),
    })[0]!;
    const read = (headers: Record<string, string>) => handler.handle(new Request(
      `https://khala.example${CLOSURE_PATH}?cleanup=1`, { headers }));
    const own = await read({ cookie: 'session=owner' });
    expect(own.status).toBe(200);
    const body = await own.text();
    expect(JSON.parse(body)).toEqual({ kind: 'ok', value: [request] });
    expect(body).not.toContain(canary.text);
    expect(body).not.toMatch(/body|accessToken|privateKey/);
    expect((await read({ authorization: 'DPoP agent-capability' })).status).toBe(401);
    expect((await read({})).status).toBe(401);
    expect(await (await read({ cookie: 'session=peer' })).json()).toEqual({ kind: 'ok', value: [] });
  });
});
