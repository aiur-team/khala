import { createHash, randomBytes } from 'node:crypto';
import type {
  AuthPrincipal, ControlStore, JsonValue, OwnerId, StableAgentPrincipal, TrustedClock,
} from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';
import { checkProof, proofKeyThumbprint } from '../agent-bootstrap/proof';
import type { DiscoverySessionAuthority, SessionAuthorityResult, SessionRef } from './bootstrap/handler';

const CANDIDATE_TTL_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/u;
const JKT = /^[A-Za-z0-9_-]{43}$/u;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;

export type VerifiedNativeCandidate = Readonly<{
  principal: StableAgentPrincipal;
  session: SessionRef;
  proofKeyThumbprint: string;
}>;

export type NativeSessionAuthorityPorts = Readonly<{
  store: ControlStore;
  clock: TrustedClock;
  /** Exact configured HTTPS origin, never derived from the candidate request. */
  origin: string;
  /** Resolves the canonical agent channel URL to its actual owner. */
  resolveOwner(target: string): Promise<Readonly<{ kind: 'resolved'; ownerId: OwnerId }> | Readonly<{ kind: 'rejected' | 'unavailable' }>>;
}>;

type CandidateRecord = Readonly<{ v: 1; ownerId: OwnerId; target: string; candidate: VerifiedNativeCandidate }>;
type AuthorityRecord = Readonly<{ v: 2; ownerId: OwnerId; target: string;
  candidate: VerifiedNativeCandidate; status: 'active' | 'revoked' }>;

export type ProposalResult = Readonly<{ kind: 'pending_owner' | 'approved'; candidateId: string; operationId: string }>
  | Readonly<{ kind: 'rejected' | 'unavailable' }>;
export type ApprovalResult = Readonly<{ kind: 'approved' }> | Readonly<{ kind: 'absent' | 'forbidden' | 'conflict' | 'unavailable' }>;
export type CurrentApproval = Readonly<{ kind: 'active'; target: string; proofKeyThumbprint: string; generation: number }>
  | Readonly<{ kind: 'absent' | 'unavailable' }>;
export type RevocationResult = Readonly<{ kind: 'revoked' }> | Readonly<{ kind: 'absent' | 'conflict' | 'unavailable' }>;
export type CandidateView = Readonly<{ kind: 'pending'; target: string; proofKeyThumbprint: string; harnessLabel: string;
  sessionLabel: string; generation: number }> | Readonly<{ kind: 'absent' | 'forbidden' | 'conflict' | 'unavailable' }>;

export type NativeSessionAuthority = DiscoverySessionAuthority & Readonly<{
  challenge(jkt: string): Promise<Readonly<{ kind: 'issued'; nonce: string }> | Readonly<{ kind: 'rejected' | 'unavailable' }>>;
  propose(input: Readonly<{ operationId: string; target: string; session: SessionRef; nonce: string; proof: string | null }>): Promise<ProposalResult>;
  pending(input: Readonly<{ candidateId: string; principal: AuthPrincipal }>): Promise<CandidateView>;
  current(input: Readonly<{ principal: AuthPrincipal; harness: string; sessionId: string }>): Promise<CurrentApproval>;
  revoke(input: Readonly<{ principal: AuthPrincipal; harness: string; sessionId: string;
    proofKeyThumbprint: string; generation: number }>): Promise<RevocationResult>;
  /** The principal must come from the signed-in owner's authenticated request. */
  approve(input: Readonly<{ candidateId: string; principal: AuthPrincipal }>): Promise<ApprovalResult>;
}>;

function key(domain: string, parts: readonly string[]): string {
  return `native-session-authority:${domain}:${createHash('sha256')
    .update(JSON.stringify(['khala.native-session-authority.v1', domain, ...parts])).digest('base64url')}`;
}

function valid(candidate: VerifiedNativeCandidate): boolean {
  return typeof candidate === 'object' && candidate !== null && typeof candidate.session === 'object'
    && candidate.session !== null && typeof candidate.principal === 'string' && candidate.principal.length > 0
    && HARNESS.test(candidate.session.harness) && typeof candidate.session.sessionId === 'string'
    && candidate.session.sessionId.length > 0 && candidate.session.sessionId.length <= 256
    && Number.isSafeInteger(candidate.session.generation) && candidate.session.generation >= 0
    && JKT.test(candidate.proofKeyThumbprint);
}

function sameCandidate(a: VerifiedNativeCandidate, b: VerifiedNativeCandidate): boolean {
  return a.principal === b.principal && a.proofKeyThumbprint === b.proofKeyThumbprint
    && a.session.harness === b.session.harness && a.session.sessionId === b.session.sessionId
    && a.session.generation === b.session.generation;
}

function candidateDigest(input: { operationId: string; target: string; session: SessionRef }): string {
  return createHash('sha256').update(JSON.stringify(['khala.proof-key-candidate.v1', input.operationId,
    input.target, input.session.harness, input.session.sessionId, input.session.generation])).digest('base64url');
}

/** Durable owner approval for a proof key; the native session string is a local label. */
export function createNativeSessionAuthority(ports: NativeSessionAuthorityPorts): NativeSessionAuthority {
  const store = guardStore(ports.store);
  if (new URL(ports.origin).origin !== ports.origin || !ports.origin.startsWith('https://')) {
    throw new Error('proof-key authority requires an exact HTTPS origin');
  }
  return {
    async challenge(jkt) {
      if (!JKT.test(jkt)) return { kind: 'rejected' };
      const nonce = randomBytes(32).toString('base64url');
      const written = await settleWrite<JsonValue>(store, {
        key: key('challenge', [jkt, nonce]), expectedRevision: null,
        operationId: `challenge:${nonce}`,
        next: { value: { v: 1, used: false }, expiresAt: new Date(ports.clock() + 60_000).toISOString() },
      });
      return written.kind === 'applied' ? { kind: 'issued', nonce } : { kind: 'unavailable' };
    },
    async propose(input) {
      if (!ID.test(input.operationId) || typeof input.target !== 'string' || input.target.length > 2048
        || !NONCE.test(input.nonce)) return { kind: 'rejected' };
      const jkt = proofKeyThumbprint(input.proof);
      if (!jkt) return { kind: 'rejected' };
      const verified = checkProof(input.proof, { method: 'POST',
        url: `${ports.origin}/api/agent/channel-discovery/authority/candidate`, jkt,
        nonce: input.nonce, bodyHash: candidateDigest(input), nowMs: ports.clock() });
      if (verified.kind !== 'valid') return { kind: 'rejected' };
      const candidateIdentity: VerifiedNativeCandidate = {
        principal: `agent_${jkt}` as StableAgentPrincipal,
        session: input.session, proofKeyThumbprint: jkt,
      };
      if (!valid(candidateIdentity)) return { kind: 'rejected' };
      const challengeKey = key('challenge', [jkt, input.nonce]);
      const heldChallenge = await store.read<JsonValue>(challengeKey);
      if (heldChallenge.kind === 'unavailable') return { kind: 'unavailable' };
      if (heldChallenge.kind !== 'record' || heldChallenge.record.expiresAt === null
        || ports.clock() >= Date.parse(heldChallenge.record.expiresAt)
        || !heldChallenge.record.value || typeof heldChallenge.record.value !== 'object'
        || Array.isArray(heldChallenge.record.value)
        || (heldChallenge.record.value as Record<string, JsonValue>).used !== false) return { kind: 'rejected' };
      const spentChallenge = await settleWrite<JsonValue>(store, {
        key: challengeKey, expectedRevision: heldChallenge.record.revision,
        operationId: `spend-challenge:${randomBytes(16).toString('base64url')}`,
        next: { value: { v: 1, used: true }, expiresAt: heldChallenge.record.expiresAt },
      });
      if (spentChallenge.kind === 'conflict') return { kind: 'rejected' };
      if (spentChallenge.kind !== 'applied') return { kind: 'unavailable' };
      const replay = await settleWrite<JsonValue>(store, {
        key: key('proof-replay', [jkt, verified.jti]), expectedRevision: null,
        operationId: `proof-replay:${randomBytes(16).toString('base64url')}`,
        next: { value: { v: 1 }, expiresAt: new Date(ports.clock() + CANDIDATE_TTL_MS).toISOString() },
      });
      if (replay.kind === 'conflict') return { kind: 'rejected' };
      if (replay.kind !== 'applied') return { kind: 'unavailable' };
      const resolved = await ports.resolveOwner(input.target).catch(() => ({ kind: 'unavailable' as const }));
      if (resolved.kind === 'unavailable') return { kind: 'unavailable' };
      if (resolved.kind !== 'resolved') return { kind: 'rejected' };
      const candidate: CandidateRecord = { v: 1, ownerId: resolved.ownerId, target: input.target, candidate: candidateIdentity };
      const candidateId = key('candidate-id', [input.operationId, jkt,
        input.session.harness, input.session.sessionId, String(input.session.generation)]).split(':').at(-1)!;
      const candidateKey = key('candidate', [candidateId]);
      const stored = await settleWrite<JsonValue>(store, {
        // A recheck keeps the candidate ID but uses a fresh, one-time challenge.
        // Its write operation must be distinct because the proposed expiry differs.
        key: candidateKey, expectedRevision: null, operationId: `native-propose:${candidateId}:${input.nonce}`,
        next: { value: candidate, expiresAt: new Date(ports.clock() + CANDIDATE_TTL_MS).toISOString() },
      });
      if (stored.kind === 'applied') {
        const live = await store.read<JsonValue>(candidateKey);
        if (live.kind === 'record' && isCandidate(live.record.value)
          && live.record.value.ownerId === candidate.ownerId && live.record.value.target === candidate.target
          && sameCandidate(live.record.value.candidate, candidate.candidate)) {
          const approved = await approvedCandidate(candidate);
          if (approved === 'unavailable') return { kind: 'unavailable' };
          return { kind: approved ? 'approved' : 'pending_owner', candidateId, operationId: input.operationId };
        }
        return { kind: 'unavailable' };
      }
      if (stored.kind === 'conflict' && stored.current?.value && isCandidate(stored.current.value)
        && stored.current.value.ownerId === candidate.ownerId && stored.current.value.target === candidate.target
        && sameCandidate(stored.current.value.candidate, candidate.candidate)) {
        const approved = await approvedCandidate(candidate);
        if (approved === 'unavailable') return { kind: 'unavailable' };
        return { kind: approved ? 'approved' : 'pending_owner', candidateId, operationId: input.operationId };
      }
      return { kind: stored.kind === 'conflict' ? 'rejected' : 'unavailable' };
    },
    async pending(input) {
      if (!JKT.test(input.candidateId)) return { kind: 'absent' };
      const read = await store.read<JsonValue>(key('candidate', [input.candidateId]));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind !== 'record') return { kind: 'absent' };
      if (!isCandidate(read.record.value)) return { kind: 'unavailable' };
      const candidate = read.record.value;
      if (candidate.ownerId !== input.principal.ownerId) return { kind: 'forbidden' };
      if (read.record.expiresAt === null || ports.clock() >= Date.parse(read.record.expiresAt)) return { kind: 'absent' };
      const resolved = await ports.resolveOwner(candidate.target).catch(() => ({ kind: 'unavailable' as const }));
      if (resolved.kind === 'unavailable') return { kind: 'unavailable' };
      if (resolved.kind !== 'resolved' || resolved.ownerId !== candidate.ownerId) return { kind: 'conflict' };
      return { kind: 'pending', target: candidate.target, proofKeyThumbprint: candidate.candidate.proofKeyThumbprint,
        harnessLabel: candidate.candidate.session.harness, sessionLabel: candidate.candidate.session.sessionId,
        generation: candidate.candidate.session.generation };
    },
    async current(input) {
      if (!HARNESS.test(input.harness) || typeof input.sessionId !== 'string'
        || input.sessionId.length === 0 || input.sessionId.length > 256) return { kind: 'absent' };
      const read = await store.read<JsonValue>(key('approved', [input.principal.ownerId, input.harness, input.sessionId]));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind !== 'record') return { kind: 'absent' };
      if (!isAuthority(read.record.value) || read.record.value.ownerId !== input.principal.ownerId) return { kind: 'unavailable' };
      return read.record.value.status === 'active'
        ? { kind: 'active', target: read.record.value.target,
          proofKeyThumbprint: read.record.value.candidate.proofKeyThumbprint,
          generation: read.record.value.candidate.session.generation }
        : { kind: 'absent' };
    },
    async revoke(input) {
      if (!HARNESS.test(input.harness) || typeof input.sessionId !== 'string'
        || input.sessionId.length === 0 || input.sessionId.length > 256
        || !JKT.test(input.proofKeyThumbprint) || !Number.isSafeInteger(input.generation)
        || input.generation < 0) return { kind: 'absent' };
      const authorityKey = key('approved', [input.principal.ownerId, input.harness, input.sessionId]);
      const read = await store.read<JsonValue>(authorityKey);
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind !== 'record') return { kind: 'absent' };
      if (!isAuthority(read.record.value) || read.record.value.ownerId !== input.principal.ownerId) return { kind: 'unavailable' };
      const current = read.record.value;
      if (current.candidate.proofKeyThumbprint !== input.proofKeyThumbprint
        || current.candidate.session.generation !== input.generation) return { kind: 'conflict' };
      if (current.status === 'revoked') return { kind: 'revoked' };
      const written = await settleWrite<JsonValue>(store, {
        key: authorityKey, expectedRevision: read.record.revision,
        operationId: `revoke-proof-key:${randomBytes(16).toString('base64url')}`,
        next: { value: { v: 2, ownerId: current.ownerId, target: current.target,
          candidate: current.candidate, status: 'revoked' }, expiresAt: null },
      });
      if (written.kind === 'applied') return { kind: 'revoked' };
      if (written.kind === 'conflict') return { kind: 'conflict' };
      return { kind: 'unavailable' };
    },
    async approve(input) {
      if (!JKT.test(input.candidateId)) return { kind: 'absent' };
      const read = await store.read<JsonValue>(key('candidate', [input.candidateId]));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind !== 'record') return { kind: 'absent' };
      if (!isCandidate(read.record.value)) return { kind: 'unavailable' };
      const candidate = read.record.value;
      if (candidate.ownerId !== input.principal.ownerId) return { kind: 'forbidden' };
      if (read.record.expiresAt === null || ports.clock() >= Date.parse(read.record.expiresAt)) return { kind: 'absent' };
      const resolved = await ports.resolveOwner(candidate.target).catch(() => ({ kind: 'unavailable' as const }));
      if (resolved.kind === 'unavailable') return { kind: 'unavailable' };
      if (resolved.kind !== 'resolved' || resolved.ownerId !== candidate.ownerId) return { kind: 'conflict' };
      if (ports.clock() >= Date.parse(read.record.expiresAt)) return { kind: 'absent' };
      const authority: AuthorityRecord = { v: 2, ownerId: candidate.ownerId, target: candidate.target,
        candidate: candidate.candidate, status: 'active' };
      const authorityKey = key('approved', [candidate.ownerId, candidate.candidate.session.harness, candidate.candidate.session.sessionId]);
      const prior = await store.read<JsonValue>(authorityKey);
      if (prior.kind === 'unavailable') return { kind: 'unavailable' };
      if (prior.kind === 'record') {
        if (!isAuthority(prior.record.value) || prior.record.value.ownerId !== candidate.ownerId) return { kind: 'unavailable' };
        const held = prior.record.value;
        if (held.status === 'active') return { kind: held.target === candidate.target
          && sameCandidate(held.candidate, candidate.candidate) ? 'approved' : 'conflict' };
        // Reusing the same key requires a new generation. Discovery credentials
        // also bind this record's revision, so a different key can replace it at
        // the same generation without reviving a prior approval's credentials.
        if (candidate.candidate.session.generation < held.candidate.session.generation
          || (candidate.candidate.session.generation === held.candidate.session.generation
            && candidate.candidate.proofKeyThumbprint === held.candidate.proofKeyThumbprint)) return { kind: 'conflict' };
      }
      const written = await settleWrite<JsonValue>(store, {
        key: authorityKey, expectedRevision: prior.kind === 'record' ? prior.record.revision : null,
        operationId: `native-approve:${input.candidateId}`,
        next: { value: authority, expiresAt: null },
      });
      if (written.kind === 'applied') return { kind: 'approved' };
      if (written.kind === 'conflict' && written.current?.value && isAuthority(written.current.value)
        && written.current.value.ownerId === authority.ownerId && written.current.value.status === 'active'
        && sameCandidate(written.current.value.candidate, authority.candidate)) return { kind: 'approved' };
      return { kind: written.kind === 'conflict' ? 'conflict' : 'unavailable' };
    },
    async inspect(input): Promise<SessionAuthorityResult> {
      const read = await store.read<JsonValue>(key('approved', [input.ownerId, input.session.harness, input.session.sessionId]));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind !== 'record') return { kind: 'removed' };
      if (!isAuthority(read.record.value) || read.record.value.ownerId !== input.ownerId) return { kind: 'unavailable' };
      if (read.record.value.status !== 'active') return { kind: 'removed' };
      const resolved = await ports.resolveOwner(read.record.value.target).catch(() => ({ kind: 'unavailable' as const }));
      if (resolved.kind === 'unavailable') return { kind: 'unavailable' };
      if (resolved.kind !== 'resolved' || resolved.ownerId !== input.ownerId) return { kind: 'removed' };
      const candidate = read.record.value.candidate;
      if (candidate.session.generation !== input.session.generation) return { kind: 'rebound' };
      return { kind: 'verified', principal: candidate.principal,
        currentGeneration: candidate.session.generation, proofKeyThumbprint: candidate.proofKeyThumbprint,
        authorityRevision: read.record.revision };
    },
  };

  async function approvedCandidate(candidate: CandidateRecord): Promise<boolean | 'unavailable'> {
    const read = await store.read<JsonValue>(key('approved', [candidate.ownerId,
      candidate.candidate.session.harness, candidate.candidate.session.sessionId]));
    if (read.kind === 'unavailable') return 'unavailable';
    return read.kind === 'record' && isAuthority(read.record.value)
      && read.record.value.ownerId === candidate.ownerId
      && read.record.value.target === candidate.target
      && read.record.value.status === 'active'
      && sameCandidate(read.record.value.candidate, candidate.candidate);
  }
}

function isCandidate(value: JsonValue): value is CandidateRecord & JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return record.v === 1 && typeof record.ownerId === 'string' && typeof record.target === 'string'
    && isVerifiedCandidate(record.candidate);
}

function isAuthority(value: JsonValue): value is AuthorityRecord & JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return record.v === 2 && typeof record.ownerId === 'string' && typeof record.target === 'string'
    && (record.status === 'active' || record.status === 'revoked') && isVerifiedCandidate(record.candidate);
}

function isVerifiedCandidate(value: JsonValue | undefined): value is VerifiedNativeCandidate & JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, JsonValue>;
  if (!candidate.session || typeof candidate.session !== 'object' || Array.isArray(candidate.session)) return false;
  return valid(value as VerifiedNativeCandidate);
}
