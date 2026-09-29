import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, OwnerId } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../auth/support.test';
import { thumbprint } from '../agent-bootstrap/proof';
import { createNativeSessionAuthority } from './native-session-authority';

const ORIGIN = 'https://khala.aiur.team';
const TARGET = `${ORIGIN}/channels/room-one`;
const OWNER = 'owner_one' as OwnerId;
const OTHER = 'owner_other' as OwnerId;
const SESSION = { harness: 'codex', sessionId: 'untrusted-local-label', generation: 0 };
const OPERATION = 'native-op-one';

function key() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  return { privateKey, x, jkt: thumbprint(x) };
}

function proof(identity: ReturnType<typeof key>, now: number, input: {
  operationId: string; target: string; session: typeof SESSION; nonce: string;
}, jti = randomBytes(16).toString('base64url'), signer: KeyObject = identity.privateKey) {
  const bodyHash = createHash('sha256').update(JSON.stringify(['khala.proof-key-candidate.v1',
    input.operationId, input.target, input.session.harness, input.session.sessionId, input.session.generation])).digest('base64url');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt',
    jwk: { kty: 'OKP', crv: 'Ed25519', x: identity.x } })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ htm: 'POST',
    htu: `${ORIGIN}/api/agent/channel-discovery/authority/candidate`, iat: Math.floor(now / 1000), jti,
    nonce: input.nonce, body_hash: bodyHash,
  })).toString('base64url');
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), signer).toString('base64url')}`;
}

function principal(ownerId: OwnerId): AuthPrincipal {
  return { v: 1, ownerId, providerIssuer: 'https://id.example.test', providerSubject: ownerId,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-29T12:00:00Z' };
}

function fixture() {
  let now = T0;
  let roomOwner = OWNER;
  const store = fakeStore(() => now);
  const ports = {
    store: store.store, clock: () => now, origin: ORIGIN,
    async resolveOwner(target: string) {
      return target === TARGET ? { kind: 'resolved' as const, ownerId: roomOwner } : { kind: 'rejected' as const };
    },
  };
  const first = key();
  const second = key();
  const authority = createNativeSessionAuthority(ports);
  const submit = async (identity = first, session = SESSION, operationId = OPERATION, target = TARGET) => {
    const challenge = await authority.challenge(identity.jkt);
    if (challenge.kind !== 'issued') throw new Error('challenge not issued');
    const input = { operationId, target, session, nonce: challenge.nonce };
    return { ...input, proof: proof(identity, now, input) };
  };
  return { store, ports, first, second, submit, authority,
    advance(ms: number) { now += ms; }, setRoomOwner(next: OwnerId) { roomOwner = next; }, now: () => now };
}

describe('owner-approved proof-key authority', () => {
  it('rechecks the same candidate after owner approval without changing its one-time write', async () => {
    const h = fixture();
    const first = await h.authority.propose(await h.submit());
    if (first.kind !== 'pending_owner') throw new Error('candidate not recorded');

    h.advance(1_000);
    expect(await h.authority.propose(await h.submit())).toEqual(first);
    expect(await h.authority.approve({ candidateId: first.candidateId, principal: principal(OWNER) }))
      .toEqual({ kind: 'approved' });

    h.advance(1_000);
    expect(await h.authority.propose(await h.submit())).toEqual({ ...first, kind: 'approved' });
  });

  it('isolates two keys using the same target and operation ID', async () => {
    const h = fixture();
    const first = await h.authority.propose(await h.submit());
    const secondSession = { harness: 'claude', sessionId: 'another-untrusted-label', generation: 0 };
    const second = await h.authority.propose(await h.submit(h.second, secondSession));
    if (first.kind !== 'pending_owner' || second.kind !== 'pending_owner') throw new Error('candidates not recorded');
    expect(first.candidateId).not.toBe(second.candidateId);
    expect(await h.authority.approve({ candidateId: first.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'approved' });
    expect(await h.authority.approve({ candidateId: second.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'approved' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: SESSION })).toMatchObject({
      kind: 'verified', proofKeyThumbprint: h.first.jkt,
    });
    expect(await h.authority.inspect({ ownerId: OWNER, session: secondSession })).toMatchObject({
      kind: 'verified', proofKeyThumbprint: h.second.jkt,
    });
  });

  it('refuses forged labels, substituted keys, changed targets and replayed proofs', async () => {
    const h = fixture();
    const valid = await h.submit();
    const rawLabel = { operationId: OPERATION, target: TARGET, session: SESSION, nonce: valid.nonce, proof: null };
    expect(await h.authority.propose(rawLabel)).toEqual({ kind: 'rejected' });
    expect(await h.authority.propose({ ...valid, target: `${ORIGIN}/channels/other` })).toEqual({ kind: 'rejected' });
    expect(await h.authority.propose({ ...valid, proof: proof(h.first, h.now(), valid, undefined, h.second.privateKey) }))
      .toEqual({ kind: 'rejected' });
    const proposed = await h.authority.propose(valid);
    expect(proposed.kind).toBe('pending_owner');
    expect(await h.authority.propose(valid)).toEqual({ kind: 'rejected' });
    if (proposed.kind !== 'pending_owner') throw new Error('candidate not recorded');
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OTHER) })).toEqual({ kind: 'forbidden' });
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'approved' });
    expect(await createNativeSessionAuthority(h.ports).inspect({ ownerId: OWNER, session: SESSION })).toMatchObject({
      kind: 'verified', proofKeyThumbprint: h.first.jkt,
    });
    expect(await h.authority.inspect({ ownerId: OTHER, session: SESSION })).toEqual({ kind: 'removed' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: { ...SESSION, generation: 1 } })).toEqual({ kind: 'rebound' });
  });

  it('expires candidates and rechecks exact room ownership at approval', async () => {
    const h = fixture();
    const proposed = await h.authority.propose(await h.submit());
    if (proposed.kind !== 'pending_owner') throw new Error('candidate not recorded');
    h.setRoomOwner(OTHER);
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'conflict' });
    h.setRoomOwner(OWNER);
    h.advance(5 * 60_000 + 1);
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'absent' });
  });

  it('requires explicit owner revocation before a new key or generation can replace an approval', async () => {
    const h = fixture();
    const first = await h.authority.propose(await h.submit());
    if (first.kind !== 'pending_owner') throw new Error('first candidate missing');
    expect(await h.authority.approve({ candidateId: first.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'approved' });
    const firstApproval = await h.authority.inspect({ ownerId: OWNER, session: SESSION });
    if (firstApproval.kind !== 'verified') throw new Error('first approval missing');
    const second = await h.authority.propose(await h.submit(h.second));
    if (second.kind !== 'pending_owner') throw new Error('second candidate missing');
    expect(await h.authority.approve({ candidateId: second.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'conflict' });
    const held = { principal: principal(OWNER), harness: SESSION.harness, sessionId: SESSION.sessionId,
      proofKeyThumbprint: h.first.jkt, generation: 0 };
    expect(await h.authority.revoke({ ...held, proofKeyThumbprint: h.second.jkt })).toEqual({ kind: 'conflict' });
    expect(await h.authority.revoke({ ...held, principal: principal(OTHER) })).toEqual({ kind: 'absent' });
    expect(await h.authority.revoke(held)).toEqual({ kind: 'revoked' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: SESSION })).toEqual({ kind: 'removed' });
    expect(await h.authority.approve({ candidateId: second.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'approved' });
    const replacement = await h.authority.inspect({ ownerId: OWNER, session: SESSION });
    expect(replacement).toMatchObject({
      kind: 'verified', proofKeyThumbprint: h.second.jkt,
    });
    if (replacement.kind !== 'verified') throw new Error('replacement missing');
    expect(replacement.authorityRevision).not.toBe(firstApproval.authorityRevision);
    expect(await h.authority.revoke({ ...held, proofKeyThumbprint: h.second.jkt })).toEqual({ kind: 'revoked' });
    expect(await h.authority.approve({ candidateId: second.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'conflict' });
    const nextGeneration = { ...SESSION, generation: 1 };
    const third = await h.authority.propose(await h.submit(h.second, nextGeneration));
    if (third.kind !== 'pending_owner') throw new Error('new generation missing');
    expect(await h.authority.approve({ candidateId: third.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'approved' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: SESSION })).toEqual({ kind: 'rebound' });
    expect(await h.authority.inspect({ ownerId: OWNER, session: nextGeneration })).toMatchObject({
      kind: 'verified', proofKeyThumbprint: h.second.jkt, currentGeneration: 1,
    });
  });

  it('invalidates a prior approval when the exact room owner changes', async () => {
    const h = fixture();
    const proposed = await h.authority.propose(await h.submit());
    if (proposed.kind !== 'pending_owner') throw new Error('candidate missing');
    expect(await h.authority.approve({ candidateId: proposed.candidateId, principal: principal(OWNER) })).toEqual({ kind: 'approved' });
    h.setRoomOwner(OTHER);
    expect(await h.authority.inspect({ ownerId: OWNER, session: SESSION })).toEqual({ kind: 'removed' });
  });
});
