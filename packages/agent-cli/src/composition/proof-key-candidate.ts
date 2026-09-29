import { createHash } from 'node:crypto';
import type { ProofSigner, SessionClaim, SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { readBounded } from '@khala/connector/bootstrap/discovery';

const CHALLENGE_PATH = '/api/agent/channel-discovery/authority/challenge';
const CANDIDATE_PATH = '/api/agent/channel-discovery/authority/candidate';
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export type CandidateOutcome = Readonly<{ kind: 'pending_owner' | 'approved'; candidateId: string; approveUrl: string }>
  | Readonly<{ kind: 'rejected' | 'unavailable' }>;

/** Files a signed proof-key candidate; a local session name remains an untrusted label. */
export function createProofKeyCandidateClient(options: Readonly<{
  signer: ProofSigner;
  sessions: SessionInspectionPort;
  origin: string;
  openBrowser?(url: string): Promise<void>;
  fetch?: typeof fetch;
}>) {
  const transport = options.fetch ?? fetch;
  async function readJson(response: Response): Promise<unknown | null> {
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
    const bytes = await readBounded(response, 4096);
    if (bytes === null) return null;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { return null; }
  }
  return async function file(input: Readonly<{ target: string; operationId: string; session: SessionClaim }>, signal?: AbortSignal): Promise<CandidateOutcome> {
    if (!ID.test(input.operationId)) return { kind: 'rejected' };
    const inspected = await options.sessions.inspect(input.session).catch(() => ({ kind: 'unavailable' as const }));
    if (inspected.kind !== 'verified' || inspected.session.harness !== input.session.harness
      || inspected.session.sessionId !== input.session.sessionId) return { kind: 'unavailable' };
    const challengeUrl = new URL(CHALLENGE_PATH, options.origin);
    challengeUrl.searchParams.set('jkt', options.signer.jkt);
    let challenge: Response;
    try { challenge = await transport(challengeUrl, { method: 'GET', redirect: 'manual', credentials: 'omit',
      ...(signal ? { signal } : {}) }); }
    catch { return { kind: 'unavailable' }; }
    if (challenge.status !== 200) return { kind: 'unavailable' };
    const challengeBody = await readJson(challenge) as { kind?: unknown; nonce?: unknown } | null;
    if (challengeBody?.kind !== 'issued' || typeof challengeBody.nonce !== 'string' || !TOKEN.test(challengeBody.nonce)) {
      return { kind: 'unavailable' };
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
    } catch { return { kind: 'unavailable' }; }
    if (response.status !== 200 && response.status !== 202) return { kind: response.status === 403 ? 'rejected' : 'unavailable' };
    const result = await readJson(response) as { kind?: unknown; candidateId?: unknown; approveUrl?: unknown; operationId?: unknown } | null;
    if (!result || result.kind !== (response.status === 200 ? 'approved' : 'pending_owner')
      || result.operationId !== input.operationId || typeof result.candidateId !== 'string' || !TOKEN.test(result.candidateId)
      || typeof result.approveUrl !== 'string') return { kind: 'unavailable' };
    let approveUrl: URL;
    try { approveUrl = new URL(result.approveUrl); } catch { return { kind: 'unavailable' }; }
    if (approveUrl.origin !== options.origin || approveUrl.pathname !== '/api/human/channel-discovery/authority/approve'
      || approveUrl.searchParams.get('candidate') !== result.candidateId) return { kind: 'unavailable' };
    if (result.kind === 'pending_owner' && options.openBrowser) {
      await options.openBrowser(approveUrl.href).catch(() => undefined);
    }
    return { kind: response.status === 200 ? 'approved' : 'pending_owner',
      candidateId: result.candidateId, approveUrl: approveUrl.href };
  };
}
