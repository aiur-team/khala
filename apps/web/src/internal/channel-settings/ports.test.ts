import { describe, expect, it } from 'vitest';
import type { RoomId } from '@khala/contracts/messaging/index';
import { createFakeCatalog } from '../../features/channel-settings/fakes';
import { createChannelSettingsController } from '../../features/channel-settings/controller';
import type { HumanClient, HumanReply } from '../composition/human-client';
import { createLocalChannelSettingsPort } from './ports';

const ROOM = 'ch_1' as RoomId;
const json = (body: unknown, status = 200): HumanReply => ({ status, body });
const agent = (n: number, label: string | null = null) => ({
  v: 1, principal: `principal-${n}`, fingerprint: `SHA256:fp-${n}`, generation: n, harness: 'claude',
  displayLabel: label, workspaceLabel: null, issuedAt: '2026-09-25T12:00:00Z',
});

/** A loopback server stand-in: one channel, an owner-issued descriptor list, and a recorded request log. */
function fakeServer(initial: Readonly<{ visibility?: string; revision?: number; allowlist?: string[] }> = {}) {
  const state = { visibility: initial.visibility ?? 'secret', revision: initial.revision ?? 0, allowlist: initial.allowlist ?? [] };
  const agents = [agent(1, 'my laptop')];
  const log: Array<{ method: string; path: string; body?: unknown }> = [];
  const reply: { next: HumanReply | null } = { next: null };
  const client: HumanClient = {
    async get(path) {
      log.push({ method: 'GET', path });
      if (path === '/api/human/discovery/agents') return json({ v: 1, agents });
      if (path === '/api/v1/channels/ch_1') return json({ channel: { title: 'Release planning' } });
      return json({ v: 1, channelId: 'ch_1', ...state });
    },
    async post(path, body) {
      log.push({ method: 'POST', path, body });
      if (reply.next) return reply.next;
      const { change } = body as { change: { kind: string; visibility?: string; principal?: string } };
      if (change.kind === 'visibility') state.visibility = change.visibility!;
      if (change.kind === 'allow') state.allowlist = [...state.allowlist, change.principal!];
      if (change.kind === 'revoke') state.allowlist = state.allowlist.filter(entry => entry !== change.principal);
      state.revision += 1;
      return json({ v: 1, channelId: 'ch_1', ...state });
    },
  };
  return { client, agents, log, reply, state };
}

describe('local channel settings port', () => {
  it('reads owner settings with fingerprints joined from the issued descriptors', async () => {
    const server = fakeServer({ visibility: 'private', revision: 2, allowlist: ['principal-1', 'principal-gone'] });
    const result = await createLocalChannelSettingsPort(server.client).read(ROOM);
    expect(result).toMatchObject({ kind: 'ok', value: { visibility: 'private', revision: '2', channelName: 'Release planning', canManage: true } });
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.value.allowlist.map(entry => entry.fingerprint)).toEqual(['SHA256:fp-1', 'unavailable']);
  });

  it('reads an unconfigured channel as secret with a null revision and no listed title', async () => {
    const result = await createLocalChannelSettingsPort(fakeServer().client).read(ROOM);
    expect(result).toMatchObject({ kind: 'ok', value: { visibility: 'secret', revision: null, listedTitle: null } });
  });

  it('WRONG-IMPLEMENTATION: a newly issued descriptor is selectable by the owner over human routes only', async () => {
    const server = fakeServer();
    const port = createLocalChannelSettingsPort(server.client);
    const before = await port.knownPrincipals();
    expect(before).toMatchObject({ kind: 'ok', value: [{ fingerprint: 'SHA256:fp-1', source: 'own_session' }] });
    // A second unjoined discovery session is issued; the owner picker must offer it without any reload of agent state.
    server.agents.push(agent(2, 'Your agent (trusted)'));
    const after = await port.knownPrincipals();
    if (after.kind !== 'ok') throw new Error('expected picker');
    expect(after.value.map(entry => entry.fingerprint)).toEqual(['SHA256:fp-1', 'SHA256:fp-2']);
    // The picker never reaches an agent-facing or free-text directory route.
    await port.read(ROOM);
    for (const call of server.log) expect(call.path.startsWith('/api/human/') || call.path.startsWith('/api/v1/channels/'), call.path).toBe(true);
    expect(server.log.some(call => call.path.includes('?') || call.path.startsWith('/api/agent/'))).toBe(false);
  });

  it('sends the seen session generation with allow and revoke, and rejects a rebound principal as stale', async () => {
    const server = fakeServer({ visibility: 'private', revision: 1 });
    const port = createLocalChannelSettingsPort(server.client);
    const change = {
      v: 1 as const, action: 'allow' as const, operationId: 'op1', roomId: ROOM, principal: 'principal-1' as never,
      expectedSessionGeneration: 1, expectedRevision: '1',
    };
    expect(await port.updateAllowlist(change)).toEqual({ kind: 'ok', value: { revision: '2' } });
    expect(server.log.at(-1)).toMatchObject({
      path: '/api/human/channels/ch_1/discovery',
      body: { operationId: 'op1', expectedRevision: 1, change: { kind: 'allow', principal: 'principal-1', expectedGeneration: 1 } },
    });
    server.reply.next = json({ v: 1, kind: 'rejected', code: 'wrong_generation' }, 409);
    expect(await port.updateAllowlist({ ...change, action: 'revoke', operationId: 'op2' })).toEqual({ kind: 'rejected', code: 'stale_revision' });
  });

  it('maps forbidden, stale and unreadable replies without implying success', async () => {
    const server = fakeServer();
    const port = createLocalChannelSettingsPort(server.client);
    const visibility = { v: 1 as const, operationId: 'op', roomId: ROOM, visibility: 'private' as const, title: null, expectedRevision: null };
    server.reply.next = json({ v: 1, kind: 'rejected', code: 'stale_revision' }, 409);
    expect(await port.setVisibility(visibility)).toEqual({ kind: 'rejected', code: 'stale_revision' });
    server.reply.next = json({ v: 1, kind: 'rejected', code: 'not_found' }, 404);
    expect(await port.setVisibility(visibility)).toEqual({ kind: 'rejected', code: 'forbidden' });
    server.reply.next = 'auth_failed';
    expect(await port.setVisibility(visibility)).toEqual({ kind: 'rejected', code: 'forbidden' });
    server.reply.next = 'network';
    expect(await port.setVisibility(visibility)).toMatchObject({ kind: 'unavailable' });
    server.reply.next = json({ oops: true });
    expect(await port.setVisibility(visibility)).toMatchObject({ kind: 'unavailable' });
  });

  it('drives the shared controller through preview, edit, cancel and error against the adapter', async () => {
    const server = fakeServer();
    const controller = createChannelSettingsController({ settings: createLocalChannelSettingsPort(server.client) }, ROOM, { createId: () => 'op-fixed' });
    controller.load();
    await vi_waitFor(() => controller.getView().phase === 'editing');
    controller.setVisibility('private');
    expect(controller.getView().preview).toMatchObject({ kind: 'listed', listing: { title: 'Release planning', visibility: 'private' } });
    controller.save();
    expect(controller.getView().phase).toBe('confirming');
    controller.cancel();
    expect(controller.getView().draftVisibility).toBe('secret');
    expect(server.log.filter(call => call.method === 'POST')).toHaveLength(0);
    controller.setVisibility('private');
    controller.save();
    server.reply.next = 'network';
    controller.confirm();
    await vi_waitFor(() => controller.getView().status.kind === 'failed');
    expect(controller.getView().status).toMatchObject({ kind: 'failed', retryable: true });
    server.reply.next = null;
    controller.retry();
    await vi_waitFor(() => controller.getView().status.kind === 'saved');
    expect(server.state.visibility).toBe('private');
    expect(server.log.filter(call => call.method === 'POST').every(call => (call.body as { operationId: string }).operationId === 'op-fixed')).toBe(true);
    controller.dispose();
  });
});

async function vi_waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

describe('reference fake parity', () => {
  it('the shared fake and the live adapter expose the same port surface', () => {
    const live = createLocalChannelSettingsPort(fakeServer().client);
    expect(Object.keys(live).sort()).toEqual(Object.keys(createFakeCatalog().port).sort());
  });
});
