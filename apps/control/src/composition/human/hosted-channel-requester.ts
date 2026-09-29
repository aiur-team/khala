import { createHash } from 'node:crypto';
import { sameJsonValue, type ChannelAccessRequesterContext, type DiscoveryRequester,
  type JsonValue, type OwnerId } from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../../auth/store';
import type { AgentChannelAccessAuthentication } from '../../channel-access/handler';
import type { HostedAdmissionAuthority } from '../agent/hosted-channel-admission';
import type { DiscoveryCredentialAuthorization, SessionRef } from '../../channel-discovery/bootstrap/handler';
import { createHostedProofKeyAuthority } from '../hosted-proof-key-authority';
import type { ProductionHumanRuntime } from './production';
import type { HostedAccessRequesterAuthority } from './hosted-channel-access-resolver';

type ApprovalContext = Readonly<{ v: 1; ownerId: OwnerId; principal: string; origin: string;
  session: SessionRef; proofKeyThumbprint: string; authorityRevision: string }>;
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/u;
export type HostedSponsorAuthentication =
  | Exclude<AgentChannelAccessAuthentication, { kind: 'authenticated' }>
  | (Extract<AgentChannelAccessAuthentication, { kind: 'authenticated' }> & Readonly<{ sponsorOwnerId: OwnerId }>);

function fingerprint(record: ApprovalContext): string {
  return createHash('sha256').update(JSON.stringify(['khala.hosted.channel-access.context.v1', record]))
    .digest('base64url');
}
function key(value: string): string { return `hosted-channel-access-context.v1.${value}`; }

/** Preserves the exact signed discovery approval for durable journal rechecks. */
export function createHostedChannelRequester(
  active: ProductionHumanRuntime,
  authorize: (request: Request, action: string) => Promise<DiscoveryCredentialAuthorization>
    = async () => ({ kind: 'unavailable' }),
): Readonly<{
  authenticateAgent(request: Request): Promise<AgentChannelAccessAuthentication>;
  /** Exact signed credential and sponsor for #532's personal-link request route. */
  authenticateSponsor(request: Request): Promise<HostedSponsorAuthentication>;
  requesterAuthority: HostedAccessRequesterAuthority;
  admissionAuthority: HostedAdmissionAuthority;
}> {
  const store = guardStore(active.store);
  const authority = createHostedProofKeyAuthority(active);
  let requestApproval: { requester: DiscoveryRequester; context: ChannelAccessRequesterContext; record: ApprovalContext } | null = null;

  async function current(record: ApprovalContext): Promise<'current' | 'revoked' | 'unavailable'> {
    const held = await authority.inspect({ ownerId: record.ownerId, session: record.session });
    if (held.kind === 'unavailable') return 'unavailable';
    return held.kind === 'verified' && held.principal === record.principal
      && held.proofKeyThumbprint === record.proofKeyThumbprint
      && held.authorityRevision === record.authorityRevision
      && held.currentGeneration === record.session.generation ? 'current' : 'revoked';
  }

  async function read(context: ChannelAccessRequesterContext): Promise<ApprovalContext | 'revoked' | 'unavailable'> {
    if (!FINGERPRINT.test(context.sessionFingerprint)) return 'revoked';
    const held = await store.read<JsonValue>(key(context.sessionFingerprint));
    if (held.kind === 'unavailable') return 'unavailable';
    if (held.kind !== 'record' || !held.record.value || typeof held.record.value !== 'object'
      || Array.isArray(held.record.value)) return 'revoked';
    const record = held.record.value as unknown as ApprovalContext;
    if (record.v !== 1 || typeof record.ownerId !== 'string' || typeof record.principal !== 'string'
      || typeof record.origin !== 'string' || !record.session || typeof record.session !== 'object'
      || typeof record.session.harness !== 'string' || typeof record.session.sessionId !== 'string'
      || !Number.isSafeInteger(record.session.generation)
      || typeof record.proofKeyThumbprint !== 'string' || typeof record.authorityRevision !== 'string'
      || fingerprint(record) !== context.sessionFingerprint || record.principal !== context.principal
      || record.origin !== context.origin || record.session.generation !== context.sessionGeneration
      || record.session.harness !== context.harness) return 'revoked';
    return record;
  }

  async function inspectContext(context: ChannelAccessRequesterContext, ownerId?: OwnerId) {
    const record = await read(context);
    if (record === 'revoked' || record === 'unavailable') return record;
    return ownerId !== undefined && record.ownerId !== ownerId ? 'revoked' : current(record);
  }

  async function authenticate(request: Request, route: 'access' | 'sponsor'): Promise<HostedSponsorAuthentication> {
    let url: URL;
    try { url = new URL(request.url); } catch { return { kind: 'rejected', code: 'forbidden' }; }
    const accessPath = request.method === 'POST' && url.pathname === '/api/agent/channel-access/request'
      || request.method === 'GET' && url.pathname === '/api/agent/channel-access/status'
      && url.searchParams.getAll('operationKind').length === 1 && url.searchParams.get('operationKind') === 'access';
    const sponsorPath = request.method === 'POST' && url.pathname === '/api/agent/channel-link/request'
      && url.search === '';
    if (!(route === 'access' ? accessPath : sponsorPath)) return { kind: 'rejected', code: 'forbidden' };
    const authorization = await authorize(request, 'request_channel_access').catch(() => ({ kind: 'unavailable' as const }));
    if (authorization.kind === 'unavailable') return { kind: 'unavailable' };
    if (authorization.kind === 'refused') return { kind: 'rejected',
      code: authorization.status === 401 ? 'auth_required' : 'forbidden' };
    const requester = authorization.requester;
    if (requester.origin !== active.env.publicAppOrigin || !authorization.session
      || typeof authorization.authorityRevision !== 'string'
      || requester.principal !== `agent_${requester.proofKey.thumbprint}`) return { kind: 'rejected', code: 'forbidden' };
    const record: ApprovalContext = { v: 1, ownerId: authorization.ownerId,
      principal: requester.principal, origin: requester.origin, session: authorization.session,
      proofKeyThumbprint: requester.proofKey.thumbprint, authorityRevision: authorization.authorityRevision };
    const digest = fingerprint(record);
    const written = await settleWrite<JsonValue>(store, { key: key(digest), expectedRevision: null,
      operationId: `hosted-channel-access-context:${digest}`, next: { value: record, expiresAt: null } });
    if (written.kind !== 'applied' && !(written.kind === 'conflict' && written.current
      && sameJsonValue(written.current.value, record))) return { kind: 'unavailable' };
    const context: ChannelAccessRequesterContext = { v: 1, principal: requester.principal,
      origin: requester.origin, sessionGeneration: requester.sessionGeneration,
      sessionFingerprint: digest, harness: authorization.session.harness,
      displayLabel: null, workspaceLabel: null };
    requestApproval = { requester, context, record };
    return { kind: 'authenticated', requester, context, sponsorOwnerId: authorization.ownerId };
  }

  return {
    authenticateAgent: request => authenticate(request, 'access'),
    authenticateSponsor: request => authenticate(request, 'sponsor'),
    requesterAuthority: {
      async inspect(requester, ownerId) {
        const held = requestApproval;
        return held && held.record.ownerId === ownerId
          && held.requester.principal === requester.principal
          && held.requester.proofKey.thumbprint === requester.proofKey.thumbprint
          && held.requester.sessionGeneration === requester.sessionGeneration
          ? current(held.record) : 'revoked';
      },
      inspectContext,
      checkContext: context => inspectContext(context),
    },
    admissionAuthority: {
      async current(input) {
        if (!FINGERPRINT.test(input.sessionFingerprint)) return 'revoked';
        const held = await store.read<JsonValue>(key(input.sessionFingerprint));
        if (held.kind === 'unavailable') return 'unavailable';
        if (held.kind !== 'record' || !held.record.value || typeof held.record.value !== 'object'
          || Array.isArray(held.record.value)) return 'revoked';
        const record = held.record.value as unknown as ApprovalContext;
        if (record.v !== 1 || typeof record.ownerId !== 'string'
          || typeof record.principal !== 'string' || typeof record.origin !== 'string'
          || !record.session || typeof record.session !== 'object'
          || typeof record.session.harness !== 'string' || typeof record.session.sessionId !== 'string'
          || !Number.isSafeInteger(record.session.generation)
          || typeof record.proofKeyThumbprint !== 'string'
          || typeof record.authorityRevision !== 'string'
          || fingerprint(record) !== input.sessionFingerprint || record.ownerId !== input.ownerId
          || record.principal !== input.requester || record.origin !== active.env.publicAppOrigin
          || record.session.generation !== input.sessionGeneration
          || record.proofKeyThumbprint !== input.requester.slice('agent_'.length)) return 'revoked';
        return current(record);
      },
    },
  };
}
