import { describe, expect, it } from 'vitest';
import type { ChannelAccessDecisionCommand, ChannelAccessRequestHandle } from '@khala/contracts/messaging/index';
import type { HumanClient, HumanReply } from '../composition/human-client';
import { createLocalChannelAccessPort } from './ports';

const ACCESS = `careq_${'A'.repeat(43)}` as ChannelAccessRequestHandle;
const CREATE = `careq_${'B'.repeat(43)}` as ChannelAccessRequestHandle;
const json = (body: unknown, status = 200): HumanReply => ({ status, body });

function fakeServer() {
  const log: Array<{ method: string; path: string; body?: unknown }> = [];
  const reply: { next: HumanReply | null } = { next: null };
  const client: HumanClient = {
    async get(path) {
      log.push({ method: 'GET', path });
      return reply.next ?? json({ v: 1, requests: [
        { requestHandle: ACCESS, operationKind: 'access' },
        { requestHandle: CREATE, operationKind: 'create' },
      ] });
    },
    async post(path, body) {
      log.push({ method: 'POST', path, body });
      return reply.next ?? json({ requestHandle: (body as { requestHandle: string }).requestHandle, ok: true });
    },
  };
  return { client, log, reply };
}

const decision = (requestHandle: ChannelAccessRequestHandle): ChannelAccessDecisionCommand => ({
  v: 1, requestHandle, expectedRevision: 'carev_1', decision: 'approve', operationId: 'op1',
});

describe('local channel access port', () => {
  it('passes the projections through undecoded for the shared controller to validate', async () => {
    const result = await createLocalChannelAccessPort(fakeServer().client).inbox();
    expect(result).toMatchObject({ kind: 'ok', value: [{ requestHandle: ACCESS }, { requestHandle: CREATE }] });
  });

  it('decides on the route that matches the request kind, with the command unchanged', async () => {
    const server = fakeServer();
    const port = createLocalChannelAccessPort(server.client);
    await port.inbox();
    await port.decide(decision(ACCESS));
    await port.decide(decision(CREATE));
    const posts = server.log.filter(call => call.method === 'POST');
    expect(posts[0]).toMatchObject({ path: `/api/human/channel-access-requests/${ACCESS}/decision`, body: decision(ACCESS) });
    expect(posts[1]).toMatchObject({ path: `/api/human/channel-create-requests/${CREATE}/decision`, body: decision(CREATE) });
  });

  it('never posts a decision for a request the inbox did not list', async () => {
    const server = fakeServer();
    const port = createLocalChannelAccessPort(server.client);
    expect(await port.decide(decision(ACCESS))).toEqual({ kind: 'rejected', code: 'not_found' });
    expect(server.log).toHaveLength(0);
  });

  it('WRONG-IMPLEMENTATION: a binding or discovery capability (403) or refused session is forbidden, never an authorized result', async () => {
    const server = fakeServer();
    const port = createLocalChannelAccessPort(server.client);
    await port.inbox();
    for (const denied of [json({ v: 1, kind: 'rejected', code: 'forbidden' }, 403), 'auth_failed' as const]) {
      server.reply.next = denied;
      expect(await port.decide(decision(ACCESS))).toEqual({ kind: 'rejected', code: 'forbidden' });
      expect(await port.setMute({ v: 1, requestHandle: ACCESS, expectedRevision: null, action: 'mute', operationId: 'op2' }))
        .toEqual({ kind: 'rejected', code: 'forbidden' });
    }
    server.reply.next = json({ v: 1, kind: 'rejected', code: 'forbidden' }, 403);
    expect(await port.inbox()).toEqual({ kind: 'rejected', code: 'forbidden' });
  });

  it('maps journal rejections and treats unknown failures as retryable unavailability', async () => {
    const server = fakeServer();
    const port = createLocalChannelAccessPort(server.client);
    await port.inbox();
    server.reply.next = json({ v: 1, kind: 'rejected', code: 'expired' }, 410);
    expect(await port.decide(decision(ACCESS))).toEqual({ kind: 'rejected', code: 'expired' });
    server.reply.next = json({ v: 1, kind: 'rejected', code: 'surprise' }, 500);
    expect(await port.decide(decision(ACCESS))).toMatchObject({ kind: 'unavailable' });
    server.reply.next = 'network';
    expect(await port.decide(decision(ACCESS))).toMatchObject({ kind: 'unavailable' });
  });

  it('validates the mute result shape', async () => {
    const server = fakeServer();
    const port = createLocalChannelAccessPort(server.client);
    const mute = { v: 1 as const, requestHandle: ACCESS, expectedRevision: null, action: 'mute' as const, operationId: 'op' };
    server.reply.next = json({ v: 1, operationKind: 'access', muted: true, revision: 'carev_2' });
    expect(await port.setMute(mute)).toEqual({ kind: 'ok', value: { v: 1, operationKind: 'access', muted: true, revision: 'carev_2' } });
    server.reply.next = json({ v: 1, muted: 'yes' });
    expect(await port.setMute(mute)).toMatchObject({ kind: 'unavailable' });
  });
});
