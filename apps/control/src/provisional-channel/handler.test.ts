import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth';
import { createProvisionalChannelHandlers } from './handler';
import type { createProvisionalChannelStore } from './store';

const request = (path: string, body?: unknown) => new Request(`https://khala.aiur.team${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});

function fixture() {
  const start = vi.fn(async () => ({ kind: 'provisional' as const, channelId: 'pc_room',
    claimToken: 'pcl_secret', expiresAt: '2026-09-29T00:00:00.000Z' }));
  const claim = vi.fn(async () => ({ kind: 'claimed' as const, channelId: 'pc_room',
    ownerId: 'human-a', repeated: false }));
  const sessionFor = vi.fn(async () => ({ harness: 'codex' as const, sessionId: 'thread-a', generation: 0 }));
  const requireHumanMutation = vi.fn(async () => ({ kind: 'authorized' as const,
    context: { principal: { ownerId: 'human-a' } } }));
  const routes = createProvisionalChannelHandlers({
    journal: { start, claim } as unknown as ReturnType<typeof createProvisionalChannelStore>,
    auth: { requireHumanMutation } as unknown as Pick<AuthService, 'requireHumanMutation'>,
    sessionFor,
    origin: 'https://khala.aiur.team',
    claimUrl: token => `https://khala.aiur.team/claim/${token}`,
  });
  return { routes, start, claim, sessionFor, requireHumanMutation };
}

describe('provisional channel routes', () => {
  it('creates only from the verified native session and returns a human claim URL', async () => {
    const f = fixture();
    const response = await f.routes.agent.handle(request('/api/agent/provisional-channels',
      { harness: 'claude', sessionId: 'forged' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'provisional',
      claimUrl: 'https://khala.aiur.team/claim/pcl_secret' });
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ harness: 'codex', sessionId: 'thread-a', generation: 0 });
  });

  it('fails closed when native identity is unavailable', async () => {
    const f = fixture();
    f.sessionFor.mockResolvedValueOnce('unsupported' as never);
    const response = await f.routes.agent.handle(request('/api/agent/provisional-channels'));
    expect(response.status).toBe(403);
    expect(f.start).not.toHaveBeenCalled();
  });

  it('refuses a claim URL outside the configured deployment origin', async () => {
    const f = fixture();
    const routes = createProvisionalChannelHandlers({
      journal: { start: f.start, claim: f.claim } as unknown as ReturnType<typeof createProvisionalChannelStore>,
      auth: { requireHumanMutation: f.requireHumanMutation } as unknown as Pick<AuthService, 'requireHumanMutation'>,
      sessionFor: f.sessionFor, origin: 'https://khala.aiur.team',
      claimUrl: token => `https://foreign.example/claim/${token}`,
    });
    const response = await routes.agent.handle(request('/api/agent/provisional-channels'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'claim_route_unavailable' });
  });

  it('requires a human mutation before it examines a claim token', async () => {
    const f = fixture();
    f.requireHumanMutation.mockResolvedValueOnce({ kind: 'rejected', code: 'signed_out' } as never);
    const denied = await f.routes.human.handle(request('/api/human/provisional-channels/claim',
      { claimToken: 'pcl_secret' }));
    expect(denied.status).toBe(401);
    expect(f.claim).not.toHaveBeenCalled();
    const accepted = await f.routes.human.handle(request('/api/human/provisional-channels/claim',
      { claimToken: 'pcl_secret' }));
    expect(accepted.status).toBe(200);
    expect(f.claim).toHaveBeenCalledExactlyOnceWith('pcl_secret', 'human-a');
  });
});
