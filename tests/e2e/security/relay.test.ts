// U2: what each server-side store and log holds. The encrypted relay (Synapse) is
// reached from the human browser and owner-authorized control flows, and only a disposable live deployment
// can show its records and logs; this suite had none, so relay confidentiality is
// not observed here. A tripwire fails when a new relay path appears. What runs
// in-process is inspected: the internal-mode loopback server's store and logs, and
// the hosted connector's owner-local ledger.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, DeviceId, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { createMatrixClosureTransport } from '../../../apps/control/src/channel-closure/matrix';
import type { MatrixSessionIssuer } from '../../../apps/control/src/composition/human/matrix';
import { describeLeaks, mintCanary, scanTree } from './fixtures';
import { closeHostedWorlds, runGatedRelease } from './hosted-world';
import { REPO_ROOT, relayAdapterEvidence } from './inventory';
import { type InternalWorld, channelId, otherChannelId, startInternalWorld } from './internal-world';

const worlds: InternalWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  await closeHostedWorlds();
});

async function world(): Promise<InternalWorld> {
  const started = await startInternalWorld();
  worlds.push(started);
  return started;
}

describe('server-side stores and logs', () => {
  it('internal mode keeps message plaintext in the host channel store: a documented non-guarantee', async () => {
    const w = await world();
    const own = mintCanary('own');
    const other = mintCanary('other');
    w.say(channelId, own.text);
    w.say(otherChannelId, other.text);
    // Local single-machine mode has no relay and no end-to-end encryption. Any process
    // running as the same OS user can read this store; the connector gate does not
    // cover it. If this stops holding, the evidence file must be updated.
    const found = scanTree(w.serverState, [own, other]).map(leak => leak.canary);
    expect(new Set(found)).toEqual(new Set(['own', 'other']));
  });

  it('internal-mode server logs and error responses never carry a message body', async () => {
    const w = await world();
    const canary = mintCanary('body');
    w.say(channelId, canary.text);
    const responses = [
      // Malformed, oversized and cross-channel sends that carry the canary in the request.
      await w.http('POST', `/api/v1/channels/${channelId}/messages`, { body: { clientTxnId: 'txn-bad', content: { v: 1, kind: 'html', body: canary.text } } }),
      await w.http('POST', `/api/v1/channels/${channelId}/messages`, { body: { clientTxnId: 'txn-big', content: { v: 1, kind: 'text', body: `${canary.text}${'x'.repeat(256 * 1024)}` } } }),
      await w.http('POST', `/api/v1/channels/${otherChannelId}/messages`, { body: { clientTxnId: 'txn-x', content: { v: 1, kind: 'text', body: canary.text } } }),
      await w.http('GET', `/api/v1/channels/${channelId}/timeline?cursor=${canary.core}`),
      await w.http('GET', `/api/v1/channels/${channelId}/timeline`, { bearer: 'A'.repeat(43) }),
    ];
    for (const response of responses) expect(response.status).toBeGreaterThanOrEqual(400);
    const echoed = responses.flatMap((response, index) => (response.body.includes(canary.core) ? [index] : []));
    expect(echoed, 'error responses that echo the body').toEqual([]);
    expect(JSON.stringify(w.logs)).not.toContain(canary.core);
    expect(w.logs.length).toBeGreaterThan(0);
  });

  it('the hosted connector keeps pending plaintext only in the owner-local ledger, never in the model session', async () => {
    const gated = await runGatedRelease();
    // The owner connector is a trusted endpoint that may hold pending plaintext (KTD3).
    const ledger = scanTree(gated.state.state, [gated.pending]);
    expect(ledger.map(leak => leak.where)).toEqual(expect.arrayContaining([expect.stringMatching(/^ledger\.sqlite/)]));
    const session = gated.capture.leaks([gated.pending]);
    expect(session, describeLeaks(session)).toEqual([]);
    // Nothing outside the owner state directory holds it: the session's working directory is clean.
    const workdir = path.dirname(gated.state.state);
    const outside = scanTree(workdir, [gated.pending]).filter(leak => !leak.where.startsWith('state/'));
    expect(outside, describeLeaks(outside)).toEqual([]);
  });

  it('limits owner-authorized closure relay traffic to membership and leave without message content', async () => {
    const canary = mintCanary('relay');
    const ownerId = 'owner_relay_probe' as OwnerId;
    const roomId = '!room:matrix.example' as RoomId;
    const principal: AuthPrincipal = {
      v: 1, ownerId, providerIssuer: 'https://issuer.example', providerSubject: 'relay-probe',
      verifiedEmail: 'relay@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z',
    };
    const sessions = { issue: vi.fn(async () => ({ kind: 'ok' as const, session: {
      homeserverOrigin: 'https://matrix.example', userId: '@relay:matrix.example',
      accessToken: 'control-session-token', deviceId: 'device_relay' as DeviceId, publishedFingerprint: null,
    } })) } as unknown as MatrixSessionIssuer;
    const calls: { url: string; method: string; body: string | null; authorization: string | null }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null,
        authorization: headers.get('authorization') });
      return init?.method === 'POST' ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({ membership: 'join', ignored: canary.text }), { status: 200 });
    });
    const transport = createMatrixClosureTransport({
      principal, sessions, homeserverOrigin: 'https://matrix.example', fetch: fetch as typeof globalThis.fetch,
    });

    expect(await transport.membership(ownerId, roomId)).toBe('joined');
    expect(await transport.leave(ownerId, roomId)).toBe('left');
    expect(await transport.membership('owner_other' as OwnerId, roomId)).toBe('unavailable');
    expect(await transport.leave('owner_other' as OwnerId, roomId)).toBe('unknown');
    expect(calls).toHaveLength(2);
    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: 'https://matrix.example/_matrix/client/v3/rooms/!room%3Amatrix.example/state/m.room.member/%40relay%3Amatrix.example', method: 'GET', body: null },
      { url: 'https://matrix.example/_matrix/client/v3/rooms/!room%3Amatrix.example/leave', method: 'POST', body: '{}' },
    ]);
    expect(calls.every(call => call.authorization === 'Bearer control-session-token')).toBe(true);
    expect(JSON.stringify(calls.map(({ url, method, body }) => ({ url, method, body })))).not.toContain(canary.core);
    expect(JSON.stringify(calls.map(({ url, body }) => ({ url, body })))).not.toContain('control-session-token');
  });

  it('inventories browser and owner-authorized control access to the relay', () => {
    // KHA-132 wires the browser to Synapse; P13 closure adds an owner-account
    // control adapter for membership and leave. A connector or agent relay path
    // still changes this inventory and needs its own confidentiality evidence.
    expect(relayAdapterEvidence()).toEqual([
      'apps/web: matrix-js-sdk',
      'apps/control/src/channel-closure/matrix.ts',
      'apps/control/src/composition/human/matrix.ts',
      'apps/web/src/composition/human/matrix-browser.ts',
    ]);
    // Configuration only, not proof of confidentiality: rooms are created with Megolm enabled
    // and the client initialises Rust crypto. Relay records and logs were not inspected here.
    const browser = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/composition/human/matrix-browser.ts'), 'utf8');
    expect(browser).toMatch(/type: EventType\.RoomEncryption, state_key: '', content: \{ algorithm: 'm\.megolm\.v1\.aes-sha2' \}/);
    expect(browser).toContain('initRustCrypto(');
  });
});
