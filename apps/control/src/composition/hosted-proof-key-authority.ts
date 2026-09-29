import { createHash } from 'node:crypto';
import type { JsonValue, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { checkMutationOrigin, csrfMatches } from '../auth/csrf';
import { LOGIN_PATH } from '../auth/callback';
import { createDigests } from '../invitations/internal';
import { readInviteRecord } from '../invitations/policy';
import { createNativeSessionAuthority, type NativeSessionAuthority } from '../channel-discovery/native-session-authority';
import type { RouteRegistration } from '../runtime/handler';
import { inviteFromShareLink } from './agent/production-bootstrap';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies, type ProductionHumanRuntime } from './human/production';

export const PROOF_KEY_CHALLENGE_PATH = '/api/agent/channel-discovery/authority/challenge';
export const PROOF_KEY_CANDIDATE_PATH = '/api/agent/channel-discovery/authority/candidate';
export const PROOF_KEY_APPROVE_PATH = '/api/human/channel-discovery/authority/approve';
export const PROOF_KEY_REVOKE_PATH = '/api/human/channel-discovery/authority/revoke';
const ID = /^[A-Za-z0-9_-]{43}$/u;
const BASE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE, 'content-type': 'application/json' } });
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
}

/** A channel link is only a locator. Recheck its current creator and room owner on every use. */
async function resolveInviteOwner(active: ProductionHumanRuntime, target: string) {
  let url: URL;
  try { url = new URL(target); } catch { return { kind: 'rejected' as const }; }
  const inviteRef = inviteFromShareLink(url, active.env.publicAppOrigin);
  if (inviteRef === null) return { kind: 'rejected' as const };
  const digests = createDigests(active.env.invitationHmacSecret);
  const read = await active.store.read<JsonValue>(digests.inviteKey(inviteRef));
  if (read.kind === 'unavailable') return { kind: 'unavailable' as const };
  if (read.kind !== 'record') return { kind: 'rejected' as const };
  const invite = readInviteRecord(read.record.value);
  if (!invite || invite.inviteRefDigest !== digests.inviteRef(inviteRef) || invite.status !== 'active'
    || invite.expiresAt !== null && active.clock() >= Date.parse(invite.expiresAt)) return { kind: 'rejected' as const };
  const roomId = invite.roomId as RoomId;
  const ownerId = invite.creatorOwnerId as OwnerId;
  const authorityKey = `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`;
  const authority = await active.store.read<JsonValue>(authorityKey);
  if (authority.kind === 'unavailable') return { kind: 'unavailable' as const };
  if (authority.kind !== 'record' || !authority.record.value || typeof authority.record.value !== 'object'
    || Array.isArray(authority.record.value)) return { kind: 'rejected' as const };
  const value = authority.record.value as Record<string, JsonValue>;
  if (value.v !== 1 || value.roomId !== roomId || value.ownerId !== ownerId) return { kind: 'rejected' as const };
  const membership = await active.matrix.inspectOwnerMembership(ownerId, roomId);
  return membership.kind === 'joined' ? { kind: 'resolved' as const, ownerId }
    : { kind: 'unavailable' as const };
}

export function createHostedProofKeyAuthority(active: ProductionHumanRuntime): NativeSessionAuthority {
  return createNativeSessionAuthority({ store: active.store, clock: active.clock, origin: active.env.publicAppOrigin,
    resolveOwner: target => resolveInviteOwner(active, target) });
}

function candidateBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'generation,harness,operationId,sessionId,target,nonce'.split(',').sort().join(',')) return null;
  if (typeof body.operationId !== 'string' || typeof body.target !== 'string' || typeof body.nonce !== 'string'
    || typeof body.harness !== 'string' || typeof body.sessionId !== 'string'
    || !Number.isSafeInteger(body.generation) || (body.generation as number) < 0) return null;
  return { operationId: body.operationId, target: body.target, nonce: body.nonce,
    session: { harness: body.harness, sessionId: body.sessionId, generation: body.generation as number } };
}

/** Generated-function routes for signed candidate filing and authenticated owner approval. */
export function createHostedProofKeyAuthorityRoutes(dependencies: ProductionHumanDependencies = {}): readonly RouteRegistration[] {
  const runtime = createProductionHumanRuntimeLoader(dependencies);
  const safe = (handle: (request: Request, active: ProductionHumanRuntime, authority: NativeSessionAuthority) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
      try { const active = runtime(); return await handle(request, active, createHostedProofKeyAuthority(active)); }
      catch { return json(503, { kind: 'unavailable' }); }
    };
  return Object.freeze([
    { path: PROOF_KEY_CHALLENGE_PATH, methods: ['GET'], handle: safe(async (request, _active, authority) => {
      const url = new URL(request.url);
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== 'jkt') return json(400, { kind: 'rejected' });
      const result = await authority.challenge(url.searchParams.get('jkt')!);
      return json(result.kind === 'issued' ? 200 : result.kind === 'rejected' ? 400 : 503, result);
    }) },
    { path: PROOF_KEY_CANDIDATE_PATH, methods: ['POST'], handle: safe(async (request, active, authority) => {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json(400, { kind: 'rejected' });
      const body = candidateBody(await request.json().catch(() => null));
      if (!body) return json(400, { kind: 'rejected' });
      const result = await authority.propose({ ...body, proof: request.headers.get('dpop') });
      if (!('candidateId' in result)) return json(result.kind === 'rejected' ? 403 : 503, result);
      return json(result.kind === 'approved' ? 200 : 202,
        { ...result, approveUrl: `${active.env.publicAppOrigin}${PROOF_KEY_APPROVE_PATH}?candidate=${result.candidateId}` });
    }) },
    { path: PROOF_KEY_APPROVE_PATH, methods: ['GET', 'POST'], handle: safe(async (request, active, authority) => {
      const auth = await active.auth.authenticateRequest(request);
      if (auth.kind === 'unavailable') return json(503, { kind: 'unavailable' });
      if (auth.kind === 'signed_out' && request.method === 'GET') {
        const candidateId = new URL(request.url).searchParams.get('candidate');
        if (candidateId && ID.test(candidateId)) {
          const returnPath = `${PROOF_KEY_APPROVE_PATH}?candidate=${candidateId}`;
          return new Response(null, { status: 303, headers: { ...BASE,
            location: `${active.env.publicAppOrigin}${LOGIN_PATH}?return_to=${encodeURIComponent(returnPath)}` } });
        }
      }
      if (auth.kind !== 'authenticated') return json(401, { kind: 'sign_in_required' });
      if (request.method === 'GET') {
        const url = new URL(request.url);
        const keys = [...url.searchParams.keys()];
        const candidateId = keys.length === 1 && keys[0] === 'candidate' ? url.searchParams.get('candidate') : null;
        if (!candidateId || !ID.test(candidateId)) return json(400, { kind: 'invalid_request' });
        const pending = await authority.pending({ candidateId, principal: auth.context.principal });
        if (pending.kind !== 'pending') return json(pending.kind === 'unavailable' ? 503 : pending.kind === 'absent' ? 404 : 403, pending);
        const current = await authority.current({ principal: auth.context.principal,
          harness: pending.harnessLabel, sessionId: pending.sessionLabel });
        if (current.kind === 'unavailable') return json(503, current);
        const replace = current.kind === 'active' && (current.proofKeyThumbprint !== pending.proofKeyThumbprint
          || current.generation !== pending.generation)
          ? `<p>This local label already has an approved key. Revoke it before approving a replacement. Reusing the same key requires a higher generation.</p>
<a href="${PROOF_KEY_REVOKE_PATH}?${new URLSearchParams({ harness: pending.harnessLabel,
  session_id: pending.sessionLabel })}">Review existing approval</a>` : '';
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Approve agent proof key</title></head><body>
<h1>Approve this proof key?</h1>
<p>Approving lets anyone holding the matching private key request discovery and access to this channel. It does not admit the agent, or allow reading or sending messages. Those steps need separate approval and proof.</p>
<p>The named Codex or Claude session is a local label supplied by the requester. Khala cannot verify that provider thread exists.</p>
<dl><dt>Channel link</dt><dd>${escapeHtml(pending.target)}</dd><dt>Proof key</dt><dd>${escapeHtml(pending.proofKeyThumbprint)}</dd>
<dt>Harness label</dt><dd>${escapeHtml(pending.harnessLabel)}</dd><dt>Session label</dt><dd>${escapeHtml(pending.sessionLabel)}</dd>
<dt>Generation</dt><dd>${pending.generation}</dd></dl>
${replace}
<form method="post" action="${PROOF_KEY_APPROVE_PATH}"><input type="hidden" name="candidate" value="${candidateId}">
<input type="hidden" name="csrf_token" value="${escapeHtml(auth.context.csrfToken)}">
<button type="submit" name="decision" value="approve">Approve key</button>
<button type="submit" name="decision" value="deny">Deny</button></form></body></html>`;
        return new Response(html, { status: 200, headers: { ...BASE, 'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
      }
      if (checkMutationOrigin(request, active.env.publicAppOrigin) !== 'ok') return json(403, { kind: 'forbidden' });
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return json(400, { kind: 'invalid_request' });
      const form = new URLSearchParams(await request.text());
      if ([...form.keys()].sort().join(',') !== 'candidate,csrf_token,decision') return json(400, { kind: 'invalid_request' });
      const candidateId = form.get('candidate');
      if (!candidateId || !ID.test(candidateId) || !csrfMatches(form.get('csrf_token') ?? '', auth.context.csrfToken)) return json(403, { kind: 'forbidden' });
      if (form.get('decision') === 'deny') return json(200, { kind: 'denied' });
      if (form.get('decision') !== 'approve') return json(400, { kind: 'invalid_request' });
      const result = await authority.approve({ candidateId, principal: auth.context.principal });
      return json(result.kind === 'approved' ? 200 : result.kind === 'unavailable' ? 503
        : result.kind === 'absent' ? 404 : 403, result);
    }) },
    { path: PROOF_KEY_REVOKE_PATH, methods: ['GET', 'POST'], handle: safe(async (request, active, authority) => {
      const auth = await active.auth.authenticateRequest(request);
      if (auth.kind === 'unavailable') return json(503, { kind: 'unavailable' });
      if (auth.kind !== 'authenticated') return json(401, { kind: 'sign_in_required' });
      if (request.method === 'GET') {
        const query = new URL(request.url).searchParams;
        if ([...query.keys()].sort().join(',') !== 'harness,session_id') return json(400, { kind: 'invalid_request' });
        const harness = query.get('harness')!;
        const sessionId = query.get('session_id')!;
        const current = await authority.current({ principal: auth.context.principal, harness, sessionId });
        if (current.kind !== 'active') return json(current.kind === 'unavailable' ? 503 : 404, current);
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Revoke agent proof key</title></head><body>
<h1>Revoke this proof key?</h1>
<p>Revocation stops discovery credentials for this approval. A replacement key needs a new signed request and your approval; reusing the same key also needs a higher generation. It does not revoke a separately admitted Matrix device.</p>
<dl><dt>Proof key</dt><dd>${escapeHtml(current.proofKeyThumbprint)}</dd><dt>Harness label</dt><dd>${escapeHtml(harness)}</dd>
<dt>Session label</dt><dd>${escapeHtml(sessionId)}</dd><dt>Generation</dt><dd>${current.generation}</dd></dl>
<form method="post" action="${PROOF_KEY_REVOKE_PATH}"><input type="hidden" name="harness" value="${escapeHtml(harness)}">
<input type="hidden" name="session_id" value="${escapeHtml(sessionId)}">
<input type="hidden" name="proof_jkt" value="${escapeHtml(current.proofKeyThumbprint)}">
<input type="hidden" name="generation" value="${current.generation}">
<input type="hidden" name="csrf_token" value="${escapeHtml(auth.context.csrfToken)}">
<button type="submit" name="decision" value="revoke">Revoke key</button></form></body></html>`;
        return new Response(html, { status: 200, headers: { ...BASE, 'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
      }
      if (checkMutationOrigin(request, active.env.publicAppOrigin) !== 'ok') return json(403, { kind: 'forbidden' });
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return json(400, { kind: 'invalid_request' });
      const form = new URLSearchParams(await request.text());
      if ([...form.keys()].sort().join(',') !== 'csrf_token,decision,generation,harness,proof_jkt,session_id') return json(400, { kind: 'invalid_request' });
      const rawGeneration = form.get('generation');
      if (!csrfMatches(form.get('csrf_token') ?? '', auth.context.csrfToken)
        || form.get('decision') !== 'revoke' || !rawGeneration || !/^\d+$/u.test(rawGeneration)) return json(403, { kind: 'forbidden' });
      const result = await authority.revoke({ principal: auth.context.principal, harness: form.get('harness') ?? '',
        sessionId: form.get('session_id') ?? '', proofKeyThumbprint: form.get('proof_jkt') ?? '',
        generation: Number(rawGeneration) });
      return json(result.kind === 'revoked' ? 200 : result.kind === 'unavailable' ? 503
        : result.kind === 'absent' ? 404 : 409, result);
    }) },
  ] satisfies RouteRegistration[]);
}
