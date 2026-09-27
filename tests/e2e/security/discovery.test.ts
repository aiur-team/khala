// U2/U3: an unjoined agent cannot admit itself, and channel discovery carries no content.
//
// The real `khala internal` launcher mounts the channel discovery routes, and `khala
// internal discovery` issues a discovery-only descriptor to one harness session. That
// agent holds two credentials of its own: the launch's transport capability from
// `active.json`, and its discovery capability. Every discovery route is driven with
// them. The agent routes list, request and read status. The connector routes demand a
// proof from the separate connector key, which the probe does not sign. The human
// routes (the owner's inbox, the access and create decisions, mute, visibility and the
// verified-agent list) must refuse both credentials. Throughout, the agent's own
// requests stay `pending_owner` until the owner decides, and neither canary appears on
// any response or in the launcher's output.

import { afterEach, describe, expect, it } from 'vitest';
import { DISCOVERY_ROUTES } from '../../../apps/internal/src/server/discovery';
import { createSurfaceCapture, describeLeaks, mintCanary } from './fixtures';
import { surfacesFor } from './inventory';
import { type Reply, call, closeLaunchers, launched } from './launcher-world';

afterEach(closeLaunchers);

const SESSION = 'session-unjoined';
const id = (route: Readonly<{ method: string; path: string }>) => `http-internal:${route.method} ${route.path}`;
const bearer = (capability: string) => ({ authorization: `Bearer ${capability}` });

describe('an unjoined agent cannot admit itself through channel discovery', () => {
  it('internal-discovery: every discovery route and `khala join`, with the agent\'s own credentials', async () => {
    const world = await launched();
    const pending = mintCanary('pending');
    const approved = mintCanary('approved');
    await world.say(world.other, `before ${pending.text}`);
    await world.say(world.own, `released ${approved.text}`);
    const capture = createSurfaceCapture();
    const driven = new Set<string>();
    const add = (surface: string, reply: Reply) => {
      driven.add(surface);
      capture.add(surface, `${reply.status} ${reply.body}`);
      return reply;
    };

    // The issue route: `khala internal discovery` presents the transport capability.
    const agent = await world.discover(SESSION);
    driven.add(id(DISCOVERY_ROUTES.issue));
    // Its discovery capability cannot issue itself another descriptor.
    const reissue = add(id(DISCOVERY_ROUTES.issue), await call(world.origin, {
      method: 'POST', path: DISCOVERY_ROUTES.issue.path, headers: bearer(agent.discoveryCapability),
      body: { harness: 'codex', sessionId: 'session-other', displayLabel: null, workspaceLabel: null, proofPublicKey: 'A'.repeat(43) },
    }));
    expect(reissue.status).toBe(403);

    // `khala join` files a request for the channel the agent was never granted, and only a request.
    const target = `${world.origin}/channels/${encodeURIComponent(world.other)}`;
    const joined = await world.khala(agent.descriptorPath, ['join', target]);
    capture.add('cli:join', joined.out);
    driven.add('cli:join');
    expect(joined.out.trim()).toBe('{"ok":true,"kind":"access","outcome":"pending_owner"}');
    driven.add(id(DISCOVERY_ROUTES.journalRequestAccess));
    driven.add(id(DISCOVERY_ROUTES.accessStatus));

    // The agent routes, directly.
    const asAgent = bearer(agent.discoveryCapability);
    const listed = add(id(DISCOVERY_ROUTES.list), await call(world.origin, { path: DISCOVERY_ROUTES.list.path, headers: asAgent }));
    expect(listed.status).toBe(200);
    const accessOperation = 'kha138-own-access-00000000000000';
    const access = add(id(DISCOVERY_ROUTES.requestAccess), await call(world.origin, {
      method: 'POST', path: DISCOVERY_ROUTES.requestAccess.path, headers: asAgent,
      body: { v: 1, kind: 'channel_url', operationId: accessOperation, credentialRef: agent.principal, channelUrl: `${world.origin}/channels/${encodeURIComponent(world.own)}` },
    }));
    expect(access.body).toContain('"outcome":"pending_owner"');
    // A request naming another principal is refused: authority comes from the credential.
    const impersonated = add(id(DISCOVERY_ROUTES.journalRequestAccess), await call(world.origin, {
      method: 'POST', path: DISCOVERY_ROUTES.journalRequestAccess.path, headers: asAgent,
      body: { v: 1, kind: 'channel_url', operationId: 'kha138-forged-principal-000000000', credentialRef: 'dp_forged', channelUrl: target },
    }));
    expect([400, 403]).toContain(impersonated.status);
    const accessStatus = add(id(DISCOVERY_ROUTES.accessStatus), await call(world.origin, {
      path: `/api/agent/channel-access-requests/${accessOperation}`, headers: asAgent,
    }));
    expect(accessStatus.body).toContain('"outcome":"pending_owner"');
    const createOperation = 'kha138-create-0000000000000000000';
    const create = add(id(DISCOVERY_ROUTES.requestCreate), await call(world.origin, {
      method: 'POST', path: DISCOVERY_ROUTES.requestCreate.path, headers: asAgent,
      body: { v: 1, operationId: createOperation, credentialRef: agent.principal, origin: world.origin, proposedTitle: 'Agent proposal' },
    }));
    expect(create.body).toContain('"outcome":"pending_owner"');
    const createStatus = add(id(DISCOVERY_ROUTES.createStatus), await call(world.origin, {
      path: `/api/agent/channel-create-requests/${createOperation}`, headers: asAgent,
    }));
    expect(createStatus.body).toContain('"outcome":"pending_owner"');

    // The connector routes: a discovery capability without the connector key's proof is refused.
    for (const route of [DISCOVERY_ROUTES.exchange, DISCOVERY_ROUTES.activate, DISCOVERY_ROUTES.ready]) {
      const refused = add(id(route), await call(world.origin, {
        method: 'POST', path: route.path.replace(':operationId', accessOperation), headers: asAgent, body: {},
      }));
      expect(refused.status, route.path).toBe(401);
      expect(refused.body, route.path).toContain('proof_required');
    }

    // The human routes. The agent learns a real request handle and revision the way the owner
    // does, and presents well-formed approvals with each of its credentials.
    const requests = await world.ownerRequests();
    expect(requests.map(entry => entry.outcome)).toEqual(['pending_owner', 'pending_owner', 'pending_owner']);
    const credentials = { transport: bearer(world.transportCapability), discovery: asAgent };
    for (const [which, headers] of Object.entries(credentials)) {
      for (const { requestHandle, revision } of requests) {
        for (const route of [DISCOVERY_ROUTES.accessDecision, DISCOVERY_ROUTES.createDecision]) {
          const decided = add(id(route), await call(world.origin, {
            method: 'POST', path: route.path.replace(':requestHandle', requestHandle), headers,
            body: { v: 1, requestHandle, expectedRevision: revision, decision: 'approve', operationId: `forged-${which}-${requestHandle.slice(-8)}` },
          }));
          expect(decided.status, `${which} ${route.path}`).toBe(403);
        }
      }
      const reads = [DISCOVERY_ROUTES.inbox, DISCOVERY_ROUTES.settings, DISCOVERY_ROUTES.agents];
      for (const route of reads) {
        const read = add(id(route), await call(world.origin, { path: route.path.replace(':channelId', world.other), headers }));
        expect(read.status, `${which} ${route.path}`).toBe(403);
      }
      const writes: ReadonlyArray<readonly [typeof DISCOVERY_ROUTES[keyof typeof DISCOVERY_ROUTES], unknown]> = [
        [DISCOVERY_ROUTES.mute, { v: 1, requestHandle: requests[0]!.requestHandle, expectedRevision: requests[0]!.revision, muted: true, operationId: `mute-${which}` }],
        [DISCOVERY_ROUTES.updateSettings, { operationId: `vis-${which}`, expectedRevision: 1, change: { kind: 'visibility', visibility: 'public' } }],
      ];
      for (const [route, body] of writes) {
        const written = add(id(route), await call(world.origin, { method: 'POST', path: route.path.replace(':channelId', world.other), headers, body }));
        expect(written.status, `${which} ${route.path}`).toBe(403);
      }
    }

    // Nothing moved: every request is still waiting on the owner, from both sides.
    expect((await world.ownerRequests()).map(entry => entry.outcome)).toEqual(['pending_owner', 'pending_owner', 'pending_owner']);
    const rejoined = await world.khala(agent.descriptorPath, ['join', target]);
    capture.add('cli:join again', rejoined.out);
    expect(rejoined.out.trim()).toBe('{"ok":true,"kind":"access","outcome":"pending_owner"}');

    expect([...driven].sort()).toEqual(surfacesFor('internal-discovery'));
    capture.add('launcher-output', world.output());
    const leaks = capture.leaks([pending, approved]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
  });
});
