import { createHash } from 'node:crypto';
import type { ProofSigner, SessionClaim, SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { readBounded } from '@khala/connector/bootstrap/discovery';

const CHALLENGE_PATH = '/api/agent/channel-discovery/authority/challenge';
const CANDIDATE_PATH = '/api/agent/channel-discovery/authority/candidate';
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export type CandidateOutcome = Readonly<{ kind: 'pending_owner' | 'approved'; candidateId: string; approveUrl: string }>
  | Readonly<{ kind: 'rejected' | 'unavailable' }>;

export type CandidateDiagnostic = Readonly<{ stage: 'session_inspection' | 'challenge' | 'candidate';
  result: 'unavailable' | 'rejected'; httpStatus?: number }>;

/** Files a signed proof-key candidate; a local session name remains an untrusted label. */
export function createProofKeyCandidateClient(options: Readonly<{
  signer: ProofSigner;
  sessions: SessionInspectionPort;
  origin: string;
  fetch?: typeof fetch;
  diagnostic?(event: CandidateDiagnostic): void;
}>) {
  const transport = options.fetch ?? fetch;
  const failed = (stage: CandidateDiagnostic['stage'], result: CandidateDiagnostic['result'], httpStatus?: number) => {
    try { options.diagnostic?.({ stage, result, ...(httpStatus === undefined ? {} : { httpStatus }) }); }
    catch { /* Diagnostics cannot change a consent result. */ }
    return { kind: result } as const;
  };
  async function readJson(response: Response): Promise<unknown | null> {
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
    try {
      const bytes = await readBounded(response, 4096);
      return bytes === null ? null : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    }
    catch { return null; }
  }
  return async function file(input: Readonly<{ target: string; operationId: string; session: SessionClaim }>, signal?: AbortSignal): Promise<CandidateOutcome> {
    if (!ID.test(input.operationId)) return { kind: 'rejected' };
    const inspected = await options.sessions.inspect(input.session).catch(() => ({ kind: 'unavailable' as const }));
    if (inspected.kind !== 'verified' || inspected.session.harness !== input.session.harness
      || inspected.session.sessionId !== input.session.sessionId) return failed('session_inspection', 'unavailable');
    const challengeUrl = new URL(CHALLENGE_PATH, options.origin);
    challengeUrl.searchParams.set('jkt', options.signer.jkt);
    let challenge: Response;
    try { challenge = await transport(challengeUrl, { method: 'GET', redirect: 'manual', credentials: 'omit',
      ...(signal ? { signal } : {}) }); }
    catch { return failed('challenge', 'unavailable'); }
    if (challenge.status !== 200) return failed('challenge', 'unavailable', challenge.status);
    const challengeBody = await readJson(challenge) as { kind?: unknown; nonce?: unknown } | null;
    if (challengeBody?.kind !== 'issued' || typeof challengeBody.nonce !== 'string' || !TOKEN.test(challengeBody.nonce)) {
      return failed('challenge', 'unavailable', challenge.status);
    }
    const body = { operationId: input.operationId, target: input.target, harness: inspected.session.harness,
      sessionId: inspected.session.sessionId, generation: inspected.session.generation, nonce: challengeBody.nonce };
    const bodyHash = createHash('sha256').update(JSON.stringify(['khala.proof-key-candidate.v1', body.operationId,
      body.target, body.harness, body.sessionId, body.generation])).digest('base64url');
    const candidateUrl = new URL(CANDIDATE_PATH, options.origin);
    let response: Response;
    try {
      response = await transport(candidateUrl, { method: 'POST', redirect: 'manual', credentials: 'omit',
        ...(signal ? { signal } : {}),
        headers: { origin: options.origin, 'content-type': 'application/json', accept: 'application/json',
          dpop: options.signer.proof('POST', candidateUrl.href, undefined, { nonce: body.nonce, bodyHash }) },
        body: JSON.stringify(body),
      });
    } catch { return failed('candidate', 'unavailable'); }
    if (response.status !== 200 && response.status !== 202) return failed('candidate', response.status === 403 ? 'rejected' : 'unavailable', response.status);
    const result = await readJson(response) as { kind?: unknown; candidateId?: unknown; approveUrl?: unknown; operationId?: unknown } | null;
    if (!result || result.kind !== (response.status === 200 ? 'approved' : 'pending_owner')
      || result.operationId !== input.operationId || typeof result.candidateId !== 'string' || !TOKEN.test(result.candidateId)
      || typeof result.approveUrl !== 'string') return failed('candidate', 'unavailable', response.status);
    let approveUrl: URL;
    try { approveUrl = new URL(result.approveUrl); } catch { return failed('candidate', 'unavailable', response.status); }
    if (approveUrl.origin !== options.origin || approveUrl.pathname !== '/api/human/channel-discovery/authority/approve'
      || approveUrl.searchParams.get('candidate') !== result.candidateId) return failed('candidate', 'unavailable', response.status);
    return { kind: response.status === 200 ? 'approved' : 'pending_owner',
      candidateId: result.candidateId, approveUrl: approveUrl.href };
  };
}
