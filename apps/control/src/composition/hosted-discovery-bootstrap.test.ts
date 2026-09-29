import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryRequester } from '@khala/contracts/messaging/index';
import { createDiscoveryChannelAccessAuthentication } from './hosted-discovery-bootstrap';

const origin = 'https://khala.aiur.team';
const requester = {
  principal: 'agent_key-one', origin, sessionGeneration: 4,
  proofKey: { algorithm: 'Ed25519', publicKey: 'a'.repeat(43), thumbprint: 'b'.repeat(43) },
} as DiscoveryRequester;

describe('hosted channel-access authentication adapter', () => {
  it('passes only verified proof-key facts and the exact route scope', async () => {
    const authorize = vi.fn(async (_request: Request, action: string) => ({
      kind: 'authorized' as const, action, ownerId: 'owner_one', requester,
    })) as unknown as Parameters<typeof createDiscoveryChannelAccessAuthentication>[0];
    const authenticate = createDiscoveryChannelAccessAuthentication(authorize);
    const result = await authenticate(new Request(`${origin}/api/agent/channel-access/request`, {
      method: 'POST', headers: { 'x-khala-session-id': 'forged-thread' },
    }));
    expect(result).toEqual({ kind: 'authenticated', requester, context: {
      v: 1, principal: requester.principal, origin, sessionGeneration: 4,
      sessionFingerprint: requester.proofKey.thumbprint, harness: 'proof-key',
      displayLabel: null, workspaceLabel: null,
    } });
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), 'request_channel_access');
    await authenticate(new Request(`${origin}/api/agent/channel-access/status?v=1&operationKind=create`));
    expect(authorize).toHaveBeenLastCalledWith(expect.any(Request), 'request_channel_create');
    expect(await authenticate(new Request(`${origin}/api/agent/channel-access/status?v=1&operationKind=create&operationKind=access`)))
      .toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(authorize).toHaveBeenCalledTimes(2);
  });
});
