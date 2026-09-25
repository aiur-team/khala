import { describe, expect, it } from 'vitest';
import type {
  AuthPrincipal,
  ChannelAccessOwnerProjection,
  ChannelAccessRequesterContext,
  DiscoveryRequester,
  OwnerId,
} from '@khala/contracts/messaging/index';
import type { Authentication, MutationAuthorization } from '../auth';
import { ORIGIN as AUTH_ORIGIN, harness as authHarness, signIn } from '../auth/support.test';
import type { ChannelAccessService } from './service';
import {
  AGENT_CHANNEL_ACCESS_CREATE_PATH,
  AGENT_CHANNEL_ACCESS_REQUEST_PATH,
  AGENT_CHANNEL_ACCESS_STATUS_PATH,
  HUMAN_CHANNEL_ACCESS_DECISION_PATH,
  HUMAN_CHANNEL_ACCESS_INBOX_PATH,
  HUMAN_CHANNEL_ACCESS_MUTE_PATH,
  createChannelAccessHandlers,
  type AgentChannelAccessAuthentication,
  type ChannelAccessHandlerDependencies,
} from './handler';

const DIGEST = 'a'.repeat(43);
const HANDLE = `careq_${DIGEST}` as ChannelAccessOwnerProjection['requestHandle'];
const requester: DiscoveryRequester = {
  principal: 'principal_1' as DiscoveryRequester['principal'],
  origin: 'https://khala.example',
  proofKey: { algorithm: 'Ed25519', publicKey: 'b'.repeat(43), thumbprint: 'c'.repeat(43) },
  sessionGeneration: 3,
};
const requesterContext: ChannelAccessRequesterContext = {
  v: 1,
  principal: requester.principal,
  origin: requester.origin,
  sessionGeneration: requester.sessionGeneration,
  sessionFingerprint: DIGEST,
  harness: 'codex',
  displayLabel: 'Build agent',
  workspaceLabel: 'Khala',
};
const owner: AuthPrincipal = {
  v: 1,
  ownerId: 'owner_1' as OwnerId,
  providerIssuer: 'https://identity.example',
  providerSubject: 'subject_1',
  verifiedEmail: 'owner@example.com',
  sessionExpiresAt: '2026-09-25T12:00:00Z',
};
const projection: ChannelAccessOwnerProjection = {
  v: 1,
  requestHandle: HANDLE,
  operationKind: 'access',
  outcome: 'pending_owner',
  revision: 'carev_1',
  requester: { sessionFingerprint: DIGEST, harness: 'codex', displayLabel: 'Build agent', workspaceLabel: 'Khala' },
  detail: { kind: 'access', title: 'Private channel', history: 'none' },
  createdAt: '2026-09-24T12:00:00Z',
  deadline: '2026-10-01T12:00:00Z',
  ownerDecision: 'pending',
  decidedAt: null,
  muted: false,
  muteRevision: null,
};

function dependencies(overrides: Partial<ChannelAccessHandlerDependencies> = {}) {
  const calls = { access: [] as unknown[], create: [] as unknown[], status: [] as unknown[], inbox: [] as unknown[], decision: [] as unknown[], mute: [] as unknown[] };
  const service = {
    journal: {
      async requestAccess(...args: unknown[]) { calls.access.push(args); return { v: 1 as const, operationId: 'access_1', outcome: 'pending_owner' as const }; },
      async requestCreate(...args: unknown[]) { calls.create.push(args); return { v: 1 as const, operationId: 'create_1', outcome: 'pending_owner' as const }; },
      async inspect(...args: unknown[]) { calls.status.push(args); return { v: 1 as const, operationId: 'access_1', outcome: 'approved' as const }; },
    },
    decisions: {
      async inbox(...args: unknown[]) { calls.inbox.push(args); return { kind: 'ok' as const, value: [projection] }; },
      async decide(...args: unknown[]) { calls.decision.push(args); return { kind: 'ok' as const, value: { ...projection, outcome: 'approved' as const, revision: 'carev_2', ownerDecision: 'approved' as const, decidedAt: '2026-09-24T12:05:00Z' } }; },
      async setMute(...args: unknown[]) { calls.mute.push(args); return { kind: 'ok' as const, value: { v: 1 as const, operationKind: 'access' as const, muted: true, revision: 'carev_2' } }; },
    },
    fulfillment: {},
    async flushNotifications() {},
  } as unknown as ChannelAccessService;
  const authenticated: AgentChannelAccessAuthentication = { kind: 'authenticated', requester, context: requesterContext };
  const deps: ChannelAccessHandlerDependencies = {
    service,
    authenticateAgent: async () => authenticated,
    auth: {
      authenticateRequest: async (): Promise<Authentication> => ({ kind: 'authenticated', context: { principal: owner, csrfToken: 'csrf' } }),
      requireHumanMutation: async (): Promise<MutationAuthorization> => ({ kind: 'authorized', context: { principal: owner, csrfToken: 'csrf' } }),
    },
    ...overrides,
  };
  return { calls, deps, handlers: createChannelAccessHandlers(deps) };
}

function route(path: string, overrides: Partial<ChannelAccessHandlerDependencies> = {}) {
  const h = dependencies(overrides);
  return { ...h, registration: [...h.handlers.agent, ...h.handlers.human].find(item => item.path === path)! };
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://khala.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('createChannelAccessHandlers', () => {
  it('registers only the six fixed channel-access routes', () => {
    const handlers = dependencies().handlers;
    expect([...handlers.agent, ...handlers.human].map(({ path, methods }) => ({ path, methods }))).toEqual([
      { path: AGENT_CHANNEL_ACCESS_REQUEST_PATH, methods: ['POST'] },
      { path: AGENT_CHANNEL_ACCESS_CREATE_PATH, methods: ['POST'] },
      { path: AGENT_CHANNEL_ACCESS_STATUS_PATH, methods: ['GET'] },
      { path: HUMAN_CHANNEL_ACCESS_INBOX_PATH, methods: ['GET'] },
      { path: HUMAN_CHANNEL_ACCESS_DECISION_PATH, methods: ['POST'] },
      { path: HUMAN_CHANNEL_ACCESS_MUTE_PATH, methods: ['POST'] },
    ]);
    expect(JSON.stringify(handlers)).not.toMatch(/exchange|grant|provider|:\w|\*/);
  });

  it('passes verified requester and session context to strict agent request, create and status calls', async () => {
    const h = dependencies();
    const [access, create, status] = h.handlers.agent;
    const accessResponse = await access!.handle(jsonRequest(access!.path, {
      v: 1, kind: 'channel_url', operationId: 'access_1', credentialRef: 'credential_1',
      channelUrl: 'https://khala.example/channels/private-channel',
    }));
    const createResponse = await create!.handle(jsonRequest(create!.path, {
      v: 1, operationId: 'create_1', credentialRef: 'credential_1', origin: requester.origin, proposedTitle: 'New channel',
    }));
    const statusResponse = await status!.handle(new Request(
      `https://khala.example${status!.path}?v=1&operationId=access_1&operationKind=access`,
    ));

    expect(await accessResponse.json()).toEqual({ v: 1, operationId: 'access_1', outcome: 'pending_owner' });
    expect(await createResponse.json()).toEqual({ v: 1, operationId: 'create_1', outcome: 'pending_owner' });
    expect(await statusResponse.json()).toEqual({ v: 1, operationId: 'access_1', outcome: 'approved' });
    expect(h.calls.access[0]).toEqual([expect.any(Object), requester, requesterContext]);
    expect(h.calls.create[0]).toEqual([expect.any(Object), requester, requesterContext]);
    expect(h.calls.status[0]).toEqual([{ v: 1, operationId: 'access_1', operationKind: 'access' }, requester, requesterContext]);
    for (const response of [accessResponse, createResponse, statusResponse]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('rejects malformed, extra and capability-shaped agent inputs before journal access', async () => {
    const h = dependencies();
    const [access, , status] = h.handlers.agent;
    const extraBody = await access!.handle(jsonRequest(access!.path, {
      v: 1, kind: 'listing_ref', operationId: 'access_1', credentialRef: 'credential_1', listingRef: 'listing_1',
      ownerId: owner.ownerId, grant: 'secret',
    }));
    const extraQuery = await status!.handle(new Request(
      `https://khala.example${status!.path}?v=1&operationId=access_1&operationKind=access&ownerId=owner_1`,
    ));
    expect(extraBody.status).toBe(400);
    expect(extraQuery.status).toBe(400);
    expect(h.calls.access).toHaveLength(0);
    expect(h.calls.status).toHaveLength(0);
    expect(JSON.stringify(await extraBody.json())).not.toContain('secret');
  });

  it('authenticates human reads and mutations and derives the owner solely from auth context', async () => {
    const h = dependencies();
    const [inbox, decision, mute] = h.handlers.human;
    const inboxResponse = await inbox!.handle(new Request(`https://khala.example${inbox!.path}`));
    const decisionResponse = await decision!.handle(jsonRequest(decision!.path, {
      v: 1, requestHandle: HANDLE, expectedRevision: 'carev_1', decision: 'approve', operationId: 'decision_1',
    }));
    const muteResponse = await mute!.handle(jsonRequest(mute!.path, {
      v: 1, requestHandle: HANDLE, expectedRevision: null, action: 'mute', operationId: 'mute_1',
    }));

    expect(inboxResponse.status).toBe(200);
    expect(await inboxResponse.json()).toEqual({ v: 1, kind: 'ok', requests: [projection] });
    expect(decisionResponse.status).toBe(200);
    expect(muteResponse.status).toBe(200);
    expect(h.calls.inbox[0]).toEqual([owner]);
    expect(h.calls.decision[0]).toEqual([expect.not.objectContaining({ ownerId: expect.anything() }), owner]);
    expect(h.calls.mute[0]).toEqual([expect.not.objectContaining({ ownerId: expect.anything() }), owner]);
  });

  it.each([
    ['signed-out read', HUMAN_CHANNEL_ACCESS_INBOX_PATH, 'read', 401],
    ['signed-out mutation', HUMAN_CHANNEL_ACCESS_DECISION_PATH, 'signed_out', 401],
    ['origin denial', HUMAN_CHANNEL_ACCESS_DECISION_PATH, 'forbidden_origin', 403],
    ['csrf denial', HUMAN_CHANNEL_ACCESS_MUTE_PATH, 'csrf_mismatch', 403],
  ] as const)('%s short-circuits before decisions', async (_name, path, authResult, expectedStatus) => {
    const auth = authResult === 'read'
      ? { authenticateRequest: async () => ({ kind: 'signed_out' as const }), requireHumanMutation: async () => { throw new Error('unused'); } }
      : {
          authenticateRequest: async () => { throw new Error('unused'); },
          requireHumanMutation: async () => ({ kind: 'rejected' as const, code: authResult }),
        };
    const h = route(path, { auth });
    const request = path === HUMAN_CHANNEL_ACCESS_INBOX_PATH
      ? new Request(`https://khala.example${path}`)
      : jsonRequest(path, { v: 1, ownerId: owner.ownerId, capability: 'forged' });
    const response = await h.registration.handle(request);
    expect(response.status).toBe(expectedStatus);
    expect(h.calls.inbox).toHaveLength(0);
    expect(h.calls.decision).toHaveLength(0);
    expect(h.calls.mute).toHaveLength(0);
  });

  it('refuses agent bearer and discovery credentials on human decision routes under real session auth', async () => {
    const auth = authHarness();
    const { cookies } = await signIn(auth);
    const agentCalls: Request[] = [];
    const h = dependencies({
      auth: auth.service,
      authenticateAgent: async request => {
        agentCalls.push(request);
        return { kind: 'authenticated', requester, context: requesterContext };
      },
    });
    const decision = h.handlers.human.find(item => item.path === HUMAN_CHANNEL_ACCESS_DECISION_PATH)!;
    const body = JSON.stringify({
      v: 1, requestHandle: HANDLE, expectedRevision: 'carev_1', decision: 'approve', operationId: 'decision_1',
    });
    const send = (headers: Record<string, string>) => decision.handle(new Request(`${AUTH_ORIGIN}${decision.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: AUTH_ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
      body,
    }));

    const bearer = await send({ authorization: `Bearer ${'d'.repeat(43)}` });
    const discovery = await send({ authorization: `DPoP ${'e'.repeat(43)}`, dpop: 'header.payload.signature', 'x-khala-csrf': 'forged' });
    const sessionWithoutCsrf = await send({ cookie: cookies.join('; '), authorization: `Bearer ${'d'.repeat(43)}` });

    expect(bearer.status).toBe(401);
    expect(discovery.status).toBe(401);
    expect(sessionWithoutCsrf.status).toBe(403);
    expect(h.calls.decision).toHaveLength(0);
    expect(agentCalls).toHaveLength(0);
  });

  it('maps dependency throws and rejected capability-shaped human bodies to finite sanitized responses', async () => {
    const failing = dependencies({
      authenticateAgent: async () => { throw new Error('credential=super-secret'); },
    });
    const failed = await failing.handlers.agent[0]!.handle(jsonRequest(AGENT_CHANNEL_ACCESS_REQUEST_PATH, {}));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ v: 1, kind: 'unavailable' });

    const h = dependencies();
    const malformed = await h.handlers.human[1]!.handle(jsonRequest(HUMAN_CHANNEL_ACCESS_DECISION_PATH, {
      v: 1, requestHandle: HANDLE, expectedRevision: 'carev_1', decision: 'approve', operationId: 'decision_1',
      ownerId: owner.ownerId, providerToken: 'super-secret',
    }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ v: 1, kind: 'rejected', code: 'invalid_request' });
    expect(h.calls.decision).toHaveLength(0);
  });
});
