import { createHash } from 'node:crypto';
import type {
  AuthPrincipal, ControlStore, JsonValue, OwnerId, StableAgentPrincipal, TrustedClock,
} from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';
import type { DiscoverySessionAuthority, SessionAuthorityResult, SessionRef } from './bootstrap/handler';

const CANDIDATE_TTL_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/u;
const JKT = /^[A-Za-z0-9_-]{43}$/u;

export type VerifiedNativeCandidate = Readonly<{
  principal: StableAgentPrincipal;
  session: SessionRef;
  proofKeyThumbprint: string;
}>;

/**
 * The verifier must establish the provider-named native invocation, proof-key
 * possession, and binding to this exact target and operation. A request body or
 * browser query is not native-session evidence.
 */
export type NativeCandidateVerifier = Readonly<{
  verify(input: Readonly<{ evidence: unknown; target: string; operationId: string }>): Promise<
    Readonly<{ kind: 'verified'; candidate: VerifiedNativeCandidate }>
    | Readonly<{ kind: 'rejected' | 'unavailable' }>
  >;
  current(candidate: VerifiedNativeCandidate): Promise<'current' | 'removed' | 'rebound' | 'unavailable'>;
}>;

export type NativeSessionAuthorityPorts = Readonly<{
  store: ControlStore;
  clock: TrustedClock;
  verifier: NativeCandidateVerifier;
  /** Resolves the canonical agent channel URL to its actual owner. */
  resolveOwner(target: string): Promise<Readonly<{ kind: 'resolved'; ownerId: OwnerId }> | Readonly<{ kind: 'rejected' | 'unavailable' }>>;
}>;

type CandidateRecord = Readonly<{ v: 1; ownerId: OwnerId; target: string; candidate: VerifiedNativeCandidate }>;
type AuthorityRecord = Readonly<{ v: 1; ownerId: OwnerId; candidate: VerifiedNativeCandidate }>;

export type ProposalResult = Readonly<{ kind: 'pending_owner'; candidateId: string; operationId: string }> | Readonly<{ kind: 'rejected' | 'unavailable' }>;
export type ApprovalResult = Readonly<{ kind: 'approved' }> | Readonly<{ kind: 'absent' | 'forbidden' | 'conflict' | 'unavailable' }>;

export type NativeSessionAuthority = DiscoverySessionAuthority & Readonly<{
  propose(input: Readonly<{ operationId: string; target: string; evidence: unknown }>): Promise<ProposalResult>;
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

/** Durable owner approval for one native session and its exact proof key. */
export function createNativeSessionAuthority(ports: NativeSessionAuthorityPorts): NativeSessionAuthority {
  const store = guardStore(ports.store);
  return {
    async propose(input) {
      if (!ID.test(input.operationId) || typeof input.target !== 'string' || input.target.length > 2048) return { kind: 'rejected' };
      const [verified, resolved] = await Promise.all([
        ports.verifier.verify(input).catch(() => ({ kind: 'unavailable' as const })),
        ports.resolveOwner(input.target).catch(() => ({ kind: 'unavailable' as const })),
      ]);
      if (verified.kind === 'unavailable' || resolved.kind === 'unavailable') return { kind: 'unavailable' };
      if (verified.kind !== 'verified' || resolved.kind !== 'resolved' || !valid(verified.candidate)) return { kind: 'rejected' };
      const candidate: CandidateRecord = { v: 1, ownerId: resolved.ownerId, target: input.target, candidate: verified.candidate };
      const candidateId = key('candidate-id', [input.operationId, verified.candidate.proofKeyThumbprint,
        verified.candidate.session.harness, verified.candidate.session.sessionId]).split(':').at(-1)!;
      const candidateKey = key('candidate', [candidateId]);
      const stored = await settleWrite<JsonValue>(store, {
        key: candidateKey, expectedRevision: null, operationId: `native-propose:${candidateId}`,
        next: { value: candidate, expiresAt: new Date(ports.clock() + CANDIDATE_TTL_MS).toISOString() },
      });
      if (stored.kind === 'applied') {
        const live = await store.read<JsonValue>(candidateKey);
        return live.kind === 'record' && isCandidate(live.record.value)
          && live.record.value.ownerId === candidate.ownerId && live.record.value.target === candidate.target
          && sameCandidate(live.record.value.candidate, candidate.candidate)
          ? { kind: 'pending_owner', candidateId, operationId: input.operationId } : { kind: 'unavailable' };
      }
      if (stored.kind === 'conflict' && stored.current?.value && isCandidate(stored.current.value)
        && stored.current.value.ownerId === candidate.ownerId && stored.current.value.target === candidate.target
        && sameCandidate(stored.current.value.candidate, candidate.candidate)) {
        return { kind: 'pending_owner', candidateId, operationId: input.operationId };
      }
      return { kind: stored.kind === 'conflict' ? 'rejected' : 'unavailable' };
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
      const [current, resolved] = await Promise.all([
        ports.verifier.current(candidate.candidate).catch(() => 'unavailable' as const),
        ports.resolveOwner(candidate.target).catch(() => ({ kind: 'unavailable' as const })),
      ]);
      if (current === 'unavailable' || resolved.kind === 'unavailable') return { kind: 'unavailable' };
      if (resolved.kind !== 'resolved' || resolved.ownerId !== candidate.ownerId) return { kind: 'conflict' };
      if (current !== 'current') return { kind: 'conflict' };
      if (ports.clock() >= Date.parse(read.record.expiresAt)) return { kind: 'absent' };
      const authority: AuthorityRecord = { v: 1, ownerId: candidate.ownerId, candidate: candidate.candidate };
      const authorityKey = key('approved', [candidate.ownerId, candidate.candidate.session.harness, candidate.candidate.session.sessionId]);
      const written = await settleWrite<JsonValue>(store, {
        key: authorityKey, expectedRevision: null, operationId: `native-approve:${input.candidateId}`,
        next: { value: authority, expiresAt: null },
      });
      if (written.kind === 'applied') return { kind: 'approved' };
      if (written.kind === 'conflict' && written.current?.value && isAuthority(written.current.value)
        && written.current.value.ownerId === authority.ownerId
        && sameCandidate(written.current.value.candidate, authority.candidate)) return { kind: 'approved' };
      return { kind: written.kind === 'conflict' ? 'conflict' : 'unavailable' };
    },
    async inspect(input): Promise<SessionAuthorityResult> {
      const read = await store.read<JsonValue>(key('approved', [input.ownerId, input.session.harness, input.session.sessionId]));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind !== 'record') return { kind: 'removed' };
      if (!isAuthority(read.record.value) || read.record.value.ownerId !== input.ownerId) return { kind: 'unavailable' };
      const candidate = read.record.value.candidate;
      if (candidate.session.generation !== input.session.generation) return { kind: 'rebound' };
      const current = await ports.verifier.current(candidate).catch(() => 'unavailable' as const);
      if (current !== 'current') return { kind: current };
      return { kind: 'verified', principal: candidate.principal,
        currentGeneration: candidate.session.generation, proofKeyThumbprint: candidate.proofKeyThumbprint };
    },
  };
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
  return record.v === 1 && typeof record.ownerId === 'string' && isVerifiedCandidate(record.candidate);
}

function isVerifiedCandidate(value: JsonValue | undefined): value is VerifiedNativeCandidate & JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, JsonValue>;
  if (!candidate.session || typeof candidate.session !== 'object' || Array.isArray(candidate.session)) return false;
  return valid(value as VerifiedNativeCandidate);
}
