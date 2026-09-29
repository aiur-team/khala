import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, OwnerId, StableAgentPrincipal } from '@khala/contracts/messaging/index';
import { fakeStore, secureRandom, T0 } from '../auth/support.test';
import { AUTHORIZE_PATH, createChannelDiscoveryBootstrapHandlers } from './bootstrap/handler';
import { createNativeSessionAuthority, type VerifiedNativeCandidate } from './native-session-authority';

const ORIGIN = 'https://khala.aiur.team';
const TARGET = `${ORIGIN}/channels/room-one`;
const OWNER = 'owner_one' as OwnerId;
const OTHER = 'owner_other' as OwnerId;
const KEY = 'A'.repeat(43);
const candidate: VerifiedNativeCandidate = {
  principal: 'agent_native_one' as StableAgentPrincipal,
  session: { harness: 'codex', sessionId: 'provider-thread-one', generation: 0 },
  proofKeyThumbprint: KEY,
};
const secondCandidate: VerifiedNativeCandidate = { ...candidate,
  principal: 'agent_native_two' as StableAgentPrincipal,
  session: { harness: 'codex', sessionId: 'provider-thread-two', generation: 0 },
  proofKeyThumbprint: 'D'.repeat(43) };

function principal(ownerId: OwnerId): AuthPrincipal {
  return { v: 1, ownerId, providerIssuer: 'https://id.example.test', providerSubject: ownerId,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-29T12:00:00Z' };
}

function fixture() {
  let now = T0;
  let current: 'current' | 'removed' | 'rebound' | 'unavailable' = 'current';
  let roomOwner = OWNER;
  const store = fakeStore(() => now);
  const ports = {
    store: store.store, clock: () => now,
    verifier: {
      async verify(input: { evidence: unknown; target: string; operationId: string }) {
        if (input.target !== TARGET || input.operationId !== 'native-op-one') return { kind: 'rejected' as const };
        if (input.evidence === 'provider-attested-proof') return { kind: 'verified' as const, candidate };
        return input.evidence === 'provider-attested-proof-two'
          ? { kind: 'verified' as const, candidate: secondCandidate } : { kind: 'rejected' as const };
      },
      async current(held: VerifiedNativeCandidate) {
        return held.proofKeyThumbprint === KEY || held.proofKeyThumbprint === secondCandidate.proofKeyThumbprint
          ? current : 'removed' as const;
      },
    },
    async resolveOwner(target: string) {
      return target === TARGET ? { kind: 'resolved' as const, ownerId: roomOwner } : { kind: 'rejected' as const };
    },
  };
  return { store, ports, authority: createNativeSessionAuthority(ports),
    advance(ms: number) { now += ms; }, setCurrent(next: typeof current) { current = next; },
    setRoomOwner(next: OwnerId) { roomOwner = next; } };
}

describe('durable native-session authority', () => {
  it('keeps two native agents distinct when they use the same channel operation ID', async () => {
    const h = fixture();
    const first = await h.authority.propose({ operationId: 'native-op-one', target: TARGET,
      evidence: 'provider-attested-proof' });
    const second = await h.authority.propose({ operationId: 'native-op-one', target: TARGET,
      evidence: 'provider-attested-proof-two' });
    if (first.kind !== 'pending_owner' || second.kind !== 'pending_owner') throw new Error('candidates not recorded');
    expect(first.candidateId).not.toBe(second.candidateId);
    expect(await h.authority.approve({ candidateId: first.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'approved' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: secondCandidate.session })).toEqual({ kind: 'removed' });
    expect(await h.authority.approve({ candidateId: second.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'approved' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: secondCandidate.session })).toMatchObject({
      kind: 'verified', principal: secondCandidate.principal, proofKeyThumbprint: secondCandidate.proofKeyThumbprint,
    });
  });

  it('requires trusted native evidence and exact owner approval before discovery consent', async () => {
    const h = fixture();
    const request = { operationId: 'native-op-one', target: TARGET, evidence: 'provider-attested-proof' };
    expect(await h.authority.propose({ ...request, evidence: { harness: 'codex', sessionId: candidate.session.sessionId } }))
      .toEqual({ kind: 'rejected' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: candidate.session })).toEqual({ kind: 'removed' });
    const proposed = await h.authority.propose(request);
    expect(proposed).toMatchObject({ kind: 'pending_owner', operationId: request.operationId });
    if (proposed.kind !== 'pending_owner') throw new Error('candidate not recorded');
    expect(await h.authority.propose(request)).toEqual(proposed);
    expect(await h.authority.inspect({ ownerId: OWNER, session: candidate.session })).toEqual({ kind: 'removed' });
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OTHER) }))
      .toEqual({ kind: 'forbidden' });
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'approved' });

    // A reconstructed composition reads the same durable authority. The browser
    // can only request the key already verified by the native ingress.
    const restarted = createNativeSessionAuthority(h.ports);
    expect(await restarted.inspect({ ownerId: OWNER, session: candidate.session })).toEqual({
      kind: 'verified', principal: candidate.principal, currentGeneration: 0, proofKeyThumbprint: KEY,
    });
    const bootstrap = createChannelDiscoveryBootstrapHandlers({
      origin: ORIGIN, store: h.store.store, clock: h.ports.clock, random: secureRandom,
      authenticate: async () => ({ kind: 'authenticated', context: { principal: principal(OWNER), csrfToken: 'csrf' } }),
      sessionAuthority: restarted,
      trustedSource: async () => ({ kind: 'trusted', source: 'edge:test' }),
      limiter: { reserve: async () => ({ kind: 'reserved', permit: { permitId: 'permit' } }),
        finalize: async () => ({ kind: 'released' }) },
    });
    const consent = (jkt: string) => bootstrap.human[0]!.handle(new Request(`${ORIGIN}${AUTHORIZE_PATH}?${new URLSearchParams({
      redirect_uri: 'http://127.0.0.1:49152/khala/discovery/callback', state: 'state-0123456789abcdef',
      code_challenge: 'B'.repeat(43), code_challenge_method: 'S256', origin: ORIGIN,
      harness: candidate.session.harness, session_id: candidate.session.sessionId,
      generation: '0', proof_jkt: jkt,
    })}`));
    expect((await consent(KEY)).status).toBe(200);
    expect((await consent('C'.repeat(43))).status).toBe(403);
    expect(await restarted.inspect({ ownerId: OTHER, session: candidate.session })).toEqual({ kind: 'removed' });
    expect(await restarted.inspect({ ownerId: OWNER, session: { ...candidate.session, generation: 1 } }))
      .toEqual({ kind: 'rebound' });
  });

  it('fails closed when native freshness is lost or the owner waits past the candidate lease', async () => {
    const h = fixture();
    const request = { operationId: 'native-op-one', target: TARGET, evidence: 'provider-attested-proof' };
    const proposed = await h.authority.propose(request);
    if (proposed.kind !== 'pending_owner') throw new Error('candidate not recorded');
    h.advance(5 * 60_000 + 1);
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'absent' });
    const fresh = fixture();
    const freshProposed = await fresh.authority.propose(request);
    if (freshProposed.kind !== 'pending_owner') throw new Error('candidate not recorded');
    fresh.setCurrent('rebound');
    expect(await fresh.authority.approve({ candidateId: freshProposed.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'conflict' });
    fresh.setCurrent('current');
    expect(await fresh.authority.approve({ candidateId: freshProposed.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'approved' });
    fresh.setCurrent('removed');
    expect(await fresh.authority.inspect({ ownerId: OWNER, session: candidate.session })).toEqual({ kind: 'removed' });

    const moved = fixture();
    const movedProposed = await moved.authority.propose(request);
    if (movedProposed.kind !== 'pending_owner') throw new Error('candidate not recorded');
    moved.setRoomOwner(OTHER);
    expect(await moved.authority.approve({ candidateId: movedProposed.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'conflict' });
  });
});
