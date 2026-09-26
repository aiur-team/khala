import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeInternalDescriptor } from '@khala/contracts/internal/descriptor';
import { INTERNAL_DISCOVERY_SCOPES, encodeInternalDiscoveryDescriptor } from '@khala/contracts/internal/discovery-descriptor';
import { afterEach, describe, expect, it } from 'vitest';
import { createInternalDiscoveryClient, selectInternalDiscovery } from './internal-discovery.js';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const ORIGIN = 'http://127.0.0.1:4871';
const CAPABILITY = 'A'.repeat(42) + 'E';
const TRANSPORT = 'B'.repeat(42) + 'E';
const PRINCIPAL = `agent_${'p'.repeat(43)}`;

function files(mode = 0o600) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-internal-discovery-'));
  temporary.push(root);
  const descriptorPath = path.join(root, 'descriptor.json');
  const activePath = path.join(root, 'active.json');
  fs.writeFileSync(descriptorPath, encodeInternalDiscoveryDescriptor({
    v: 1, kind: 'discovery', principal: PRINCIPAL, generation: 2, discoveryCapability: CAPABILITY, scopes: INTERNAL_DISCOVERY_SCOPES,
  }), { mode });
  fs.writeFileSync(activePath, encodeInternalDescriptor({ v: 1, channelId: 'ch_1', origin: ORIGIN, transportCapability: TRANSPORT }), { mode: 0o600 });
  fs.chmodSync(descriptorPath, mode);
  return { root, descriptorPath, activePath };
}

type Seen = { url: string; init: RequestInit };

function stub(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const seen: Seen[] = [];
  const fetchStub = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fetchStub, seen };
}

describe('internal discovery descriptor selection', () => {
  it('selects an owner-private descriptor with the live origin from active.json', () => {
    const paths = files();
    expect(selectInternalDiscovery(paths)).toEqual({
      kind: 'selected',
      selection: { origin: ORIGIN, descriptor: expect.objectContaining({ principal: PRINCIPAL, generation: 2, discoveryCapability: CAPABILITY }) },
    });
  });

  it('refuses group- or world-readable, symlinked, missing and malformed descriptors', () => {
    expect(selectInternalDiscovery(files(0o640))).toEqual({ kind: 'discovery_required' });
    const paths = files();
    const link = path.join(paths.root, 'link.json');
    fs.symlinkSync(paths.descriptorPath, link);
    expect(selectInternalDiscovery({ ...paths, descriptorPath: link })).toEqual({ kind: 'discovery_required' });
    expect(selectInternalDiscovery({ ...paths, activePath: path.join(paths.root, 'missing.json') })).toEqual({ kind: 'discovery_required' });
    fs.writeFileSync(paths.descriptorPath, '{"v":1,"kind":"discovery"}', { mode: 0o600 });
    expect(selectInternalDiscovery(paths)).toEqual({ kind: 'discovery_required' });
  });
});

describe('internal discovery client', () => {
  it('lists with the discovery capability as a bearer and never follows redirects', async () => {
    const paths = files();
    const page = { v: 1, items: [], nextCursor: null };
    const { fetchStub, seen } = stub(200, page);
    const client = createInternalDiscoveryClient({ select: () => selectInternalDiscovery(paths), fetch: fetchStub });
    expect(await client.listChannels({ origin: null, cursor: 'lcur_1' })).toEqual({ kind: 'listed', page });
    expect(seen[0]!.url).toBe(`${ORIGIN}/api/agent/channels?cursor=lcur_1`);
    expect(seen[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${CAPABILITY}`);
    // Internal discovery has exactly one origin; a caller-chosen origin is refused before any request.
    expect(await client.listChannels({ origin: 'https://khala.example', cursor: null })).toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(seen).toHaveLength(1);
  });

  it('maps statuses to finite results and treats redirects as unavailable', async () => {
    const paths = files();
    const cases: Array<[number, unknown]> = [
      [401, { kind: 'refused', code: 'discovery_required' }],
      [403, { kind: 'refused', code: 'discovery_denied' }],
      [410, { kind: 'refused', code: 'cursor_unavailable' }],
      [429, { kind: 'refused', code: 'rate_limited' }],
      [302, { kind: 'unavailable' }],
      [503, { kind: 'unavailable' }],
    ];
    for (const [status, expected] of cases) {
      const { fetchStub } = stub(status, '', { location: 'https://hostile.example/' });
      const client = createInternalDiscoveryClient({ select: () => selectInternalDiscovery(paths), fetch: fetchStub });
      expect(await client.listChannels({ origin: null, cursor: null }), String(status)).toEqual(expected);
    }
  });

  it('fills the principal as the credential reference and never sends the capability in a body', async () => {
    const paths = files();
    const { fetchStub, seen } = stub(200, { v: 1, operationId: 'op-1', outcome: 'pending_owner' });
    const client = createInternalDiscoveryClient({ select: () => selectInternalDiscovery(paths), fetch: fetchStub });
    expect(await client.requestAccess({ v: 1, operationId: 'op-1', kind: 'channel_url', channelUrl: `${ORIGIN}/channels/ch_1` }))
      .toEqual({ kind: 'ok', body: { v: 1, operationId: 'op-1', outcome: 'pending_owner' } });
    expect(await client.requestCreate({ operationId: 'op-2', proposedTitle: 'Plan' })).toMatchObject({ kind: 'ok' });
    expect(await client.status('create', 'op-2')).toMatchObject({ kind: 'ok' });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      v: 1, operationId: 'op-1', kind: 'channel_url', channelUrl: `${ORIGIN}/channels/ch_1`, credentialRef: PRINCIPAL,
    });
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({
      v: 1, operationId: 'op-2', credentialRef: PRINCIPAL, origin: ORIGIN, proposedTitle: 'Plan',
    });
    expect(seen[2]!.url).toBe(`${ORIGIN}/api/agent/channel-create-requests/op-2`);
    for (const entry of seen) expect(String(entry.init.body ?? '')).not.toContain(CAPABILITY);
  });

  it('does not call the service without a selected descriptor', async () => {
    const { fetchStub, seen } = stub(200, {});
    const client = createInternalDiscoveryClient({ select: () => ({ kind: 'discovery_required' }), fetch: fetchStub });
    expect(await client.listChannels({ origin: null, cursor: null })).toEqual({ kind: 'refused', code: 'discovery_required' });
    expect(await client.status('access', 'op')).toEqual({ kind: 'discovery_required' });
    expect(seen).toHaveLength(0);
  });
});
