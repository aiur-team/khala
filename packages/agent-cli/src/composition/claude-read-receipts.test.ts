import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRef, SessionBinding } from '@khala/contracts/delivery/index';
import {
  CREDENTIAL_A, CREDENTIAL_B, authenticator, binding, capabilities, fakeServices, memoryState,
} from '../fixtures/claude.js';
import { callScopedConsumer } from '../cli/call-consumer.js';
import { openInbox, type BatchAcknowledgement, type BatchInbox } from '../cli/inbox.js';
import type { InboxDelivery } from '../cli/types.js';
import { createClaudeSessionAdapter, type ClaudeBindingServices } from './claude-session.js';
import { ReadOperation } from './read.js';

// Read-receipt conformance for the interactive Claude route, decided from the real file
// inbox: hooks deliver, and only the agent's own next Khala call carries the batch token
// back. An acknowledgement exists only if the inbox recorded a receipt, moved its cursor,
// and stopped re-offering the batch. Only Claude itself is absent; the test plays the agent.

const CALL = { credential: CREDENTIAL_A, sessionId: 's-1' };
const S1 = JSON.stringify(['principal-a', 'binding-1']);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function delivery(releaseId: string, generation: number): InboxDelivery {
  const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const payload = new TextEncoder().encode(JSON.stringify({ body: `peer says ${releaseId}` }));
  const event: EventRef = {
    v: 1,
    roomId: 'room-1' as EventRef['roomId'],
    eventId: `event-${releaseId}` as EventRef['eventId'],
    authorParticipantId: 'participant-1' as EventRef['authorParticipantId'],
    authorDeviceId: 'device-1' as EventRef['authorDeviceId'],
    contentDigest: digest(new TextEncoder().encode(`source-${releaseId}`)),
  };
  return {
    v: 1, releaseId, bindingId: binding('s-1', 'binding-1').bindingId, generation, events: [event],
    payloadDigest: digest(payload), payload, receivedAt: '2026-09-25T00:00:00Z',
  };
}

function route() {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-receipts-'));
  roots.push(parent);
  const stateDirectory = path.join(parent, 'state');
  const receipts: BatchAcknowledgement[] = [];
  let current = binding('s-1', 'binding-1', 1);
  const open = (generation: number): Promise<BatchInbox> => openInbox({
    stateDirectory, bindingId: 'binding-1', generation, maxPayloadBytes: 512 * 1024, maxSelectionEvents: 8,
    recordAcknowledgement: async receipt => { receipts.push(receipt); },
  });
  const base = fakeServices();
  const read = (bound: SessionBinding): ClaudeBindingServices['read'] => ({
    read: async input => new ReadOperation({
      heldBinding: bound,
      consumer: callScopedConsumer(await open(bound.generation)),
      currentBinding: async () => current,
    }).read(input),
  });
  const services = (bound: SessionBinding): ClaudeBindingServices => ({
    ...base.services(bound),
    read: read(bound),
    async send(input) {
      const result = await read(bound).read({
        bindingId: bound.bindingId, maxBytes: 4096,
        ...(input.acknowledgeToken === undefined ? {} : { acknowledgeToken: input.acknowledgeToken }),
      });
      return { ...(await base.services(bound).send({ body: input.body })), batch: result.kind === 'batch' ? result.batch : null };
    },
    async setMode(input) {
      const result = await read(bound).read({
        bindingId: bound.bindingId, maxBytes: 4096,
        ...(input.acknowledgeToken === undefined ? {} : { acknowledgeToken: input.acknowledgeToken }),
      });
      return { ...(await base.services(bound).setMode(input)), batch: result.kind === 'batch' ? result.batch : null };
    },
  });
  const state = memoryState();
  const claude = createClaudeSessionAdapter({
    authenticator: authenticator(), state, services,
    sessions: {
      resolve: async (principal, claim) => principal.principalId === 'principal-a' && claim.sessionId === 's-1' ? current : null,
    },
  });
  return {
    claude, state, receipts, read, services,
    enqueue: async (releaseId: string, generation = current.generation) => (await open(generation)).enqueue(delivery(releaseId, generation)),
    cursor: async (generation = current.generation) => (await (await open(generation)).status()).cursor.releaseId,
    /** Whether the inbox would still offer this generation's batch to the next hook pull. */
    reoffers: async (generation = current.generation) =>
      (await callScopedConsumer(await open(generation), { explicitRead: true }).readBatch({ maxBytes: 4096 }))?.items.map(item => item.record.releaseId) ?? null,
    replace: (next: SessionBinding) => { current = next; },
    generation: () => current.generation,
  };
}

const released = (receipts: readonly BatchAcknowledgement[]) => receipts.map(receipt => receipt.releaseIds);

describe('Claude read-receipt conformance against the real inbox', () => {
  it.each(['read', 'send', 'status', 'mode'] as const)('acknowledges only on the agent’s next %s call', async next => {
    const { claude, enqueue, receipts, cursor, reoffers } = route();
    await enqueue('release-1');
    // Hook delivery at a tool boundary and at Stop, repeated: no receipt, no cursor move.
    await claude.pull(CALL, { maxBytes: 4096 });
    await claude.pull(CALL, { maxBytes: 4096 });
    expect(receipts).toEqual([]);
    expect(await cursor()).toBeNull();

    if (next === 'read') await claude.read(CALL, { maxBytes: 4096 });
    if (next === 'send') await claude.send(CALL, { body: 'reply' });
    if (next === 'status') await claude.status(CALL);
    if (next === 'mode') await claude.mode(CALL);
    expect(released(receipts)).toEqual([['release-1']]);
    expect(await cursor()).toBe('release-1');
    expect(await reoffers()).toBeNull();
  });

  it('treats no later call as neutral: the batch replays and nothing is acknowledged', async () => {
    const { claude, enqueue, receipts, cursor, reoffers } = route();
    await enqueue('release-1');
    const first = await claude.pull(CALL, { maxBytes: 4096 });
    await expect(claude.pull(CALL, { maxBytes: 4096 })).resolves.toEqual(first);
    expect(receipts).toEqual([]);
    expect(await cursor()).toBeNull();
    expect(await reoffers()).toEqual(['release-1']);
    // A watcher must not re-wake the idle session for an unacknowledged delivered batch.
    await expect(claude.pending(CALL)).resolves.toEqual({ kind: 'idle' });
  });

  it('a wrong token on the right binding records nothing and the batch replays', async () => {
    const { claude, enqueue, receipts, cursor, reoffers, read } = route();
    await enqueue('release-1');
    await claude.pull(CALL, { maxBytes: 4096 });
    const held = binding('s-1', 'binding-1', 1);
    const wrong = await read(held).read({ bindingId: held.bindingId, maxBytes: 4096, acknowledgeToken: 'wrong-token' });
    expect(wrong.kind).toBe('batch');
    expect(receipts).toEqual([]);
    expect(await cursor()).toBeNull();
    expect(await reoffers()).toEqual(['release-1']);
    // The retained real token still acknowledges afterwards.
    await claude.status(CALL);
    expect(released(receipts)).toEqual([['release-1']]);
  });

  it('refuses another session or caller and never lets it acknowledge', async () => {
    const { claude, enqueue, receipts, cursor } = route();
    await enqueue('release-1');
    await claude.pull(CALL, { maxBytes: 4096 });
    await expect(claude.status({ ...CALL, sessionId: 's-2' })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    await expect(claude.status({ credential: CREDENTIAL_B, sessionId: 's-1' })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    expect(receipts).toEqual([]);
    expect(await cursor()).toBeNull();
  });

  it('fences a replaced generation and never acknowledges its batch on the new one', async () => {
    const { claude, enqueue, receipts, cursor, reoffers, replace } = route();
    await enqueue('release-1');
    await claude.pull(CALL, { maxBytes: 4096 });
    replace(binding('s-1', 'binding-1', 2));
    // The release requeues upstream onto the new generation.
    await enqueue('release-1', 2);
    await claude.pull(CALL, { maxBytes: 4096 });
    await claude.status(CALL);
    expect(receipts.map(receipt => receipt.generation)).toEqual([2]);
    expect(await cursor(1)).toBeNull();
    expect(await reoffers(1)).toEqual(['release-1']);
    expect(await cursor(2)).toBe('release-1');
  });

  it('a replayed token never acknowledges the next batch', async () => {
    const { claude, enqueue, receipts, cursor, state } = route();
    await enqueue('release-1');
    await claude.pull(CALL, { maxBytes: 4096 });
    const retained = state.tokens.get(S1)!;
    await claude.status(CALL);
    await enqueue('release-2');
    // The server stopped after the inbox committed, before the retained set cleared.
    state.tokens.set(S1, retained);
    await claude.status(CALL);
    expect(released(receipts)).toEqual([['release-1']]);
    expect(await cursor()).toBe('release-1');
  });

  it('serializes racing agent calls so exactly one carries the token', async () => {
    const { claude, enqueue, receipts, cursor } = route();
    await enqueue('release-1');
    await claude.pull(CALL, { maxBytes: 4096 });
    await Promise.all([claude.status(CALL), claude.read(CALL, { maxBytes: 4096 }), claude.send(CALL, { body: 'x' })]);
    expect(receipts).toHaveLength(1);
    expect(await cursor()).toBe('release-1');
  });

  it('puts no token in any outcome and grants no handoff without batch_token_next_call', async () => {
    const { claude, enqueue } = route();
    await enqueue('release-1');
    const outcomes = [
      await claude.pull(CALL, { maxBytes: 4096 }), await claude.read(CALL, { maxBytes: 4096 }),
      await claude.send(CALL, { body: 'x' }), await claude.status(CALL), await claude.mode(CALL),
    ];
    expect(JSON.stringify(outcomes)).not.toMatch(/"token"|batchToken/);

    const unproven = fakeServices();
    unproven.capabilities.value = capabilities('unknown');
    const closed = createClaudeSessionAdapter({
      authenticator: authenticator(), state: memoryState(), services: unproven.services,
      sessions: { resolve: async () => binding('s-1', 'binding-1') },
    });
    await expect(closed.pull(CALL, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'unproven' });
    await expect(closed.read(CALL, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'unproven' });
  });
});
