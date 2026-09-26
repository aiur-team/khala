import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CliError } from '../cli/errors.js';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import {
  BINDINGS, CREDENTIAL_A, CREDENTIAL_B, authenticator, batch, binding, capabilities, directory, fakeInbox, fakeServices, memoryState,
} from '../fixtures/claude.js';
import { createClaudeSessionAdapter, type ClaudeBindingServices } from './claude-session.js';

function adapter(overrides: Parameters<typeof directory>[0] = {}) {
  const services = fakeServices();
  const state = memoryState();
  const services_ = vi.fn(services.services);
  return {
    services, state, servicesFor: services_,
    adapter: createClaudeSessionAdapter({ authenticator: authenticator(), sessions: directory(overrides), state, services: services_ }),
  };
}

const A1 = { credential: CREDENTIAL_A, sessionId: 's-1' };
const A2 = { credential: CREDENTIAL_A, sessionId: 's-2' };
const S1 = JSON.stringify(['principal-a', 'binding-1']);
const retained = (token: string, generation = 1) => [{ generation, token }];

/** An adapter for session s-1 whose reads and sends go through a model of the shared inbox. */
function inboxAdapter(bodies: readonly string[]) {
  const inbox = fakeInbox(bodies);
  const base = fakeServices();
  const state = memoryState();
  const services = (bound: SessionBinding): ClaudeBindingServices => ({
    ...base.services(bound),
    read: inbox.port(bound.generation),
    async send(input) {
      if (input.acknowledgeToken !== undefined) inbox.acknowledge(bound.generation, input.acknowledgeToken);
      return base.services(bound).send(input);
    },
  });
  const claude = createClaudeSessionAdapter({
    authenticator: authenticator(), state, services,
    sessions: {
      resolve: async (principal, claim) => principal.principalId === 'principal-a' && claim.sessionId === 's-1'
        ? binding('s-1', 'binding-1', inbox.generation) : null,
    },
  });
  return { inbox, state, base, claude };
}

describe('Claude session adapter', () => {
  it('wrong-implementation test: same-cwd sessions each reach only their own binding through the injected khala_read', async () => {
    const { adapter: claude, services, servicesFor } = adapter();
    const inboxAccess = vi.spyOn(fs.promises, 'open');
    services.services(BINDINGS['s-1']);
    services.services(BINDINGS['s-2']);
    services.reads.get('binding-1')!.next.push({ kind: 'batch', batch: batch('token-1', '{"body":"for session one"}') });
    services.reads.get('binding-2')!.next.push({ kind: 'batch', batch: batch('token-2', '{"body":"for session two"}') });

    const one = await claude.read(A1, { maxBytes: 4096 });
    const two = await claude.read(A2, { maxBytes: 4096 });

    expect(one).toMatchObject({ kind: 'batch' });
    expect(two).toMatchObject({ kind: 'batch' });
    expect(JSON.stringify(one)).toContain('for session one');
    expect(JSON.stringify(one)).not.toContain('for session two');
    expect(JSON.stringify(two)).toContain('for session two');
    expect(services.reads.get('binding-1')!.calls).toEqual([{ bindingId: 'binding-1', maxBytes: 4096 }]);
    expect(services.reads.get('binding-2')!.calls).toEqual([{ bindingId: 'binding-2', maxBytes: 4096 }]);
    expect(servicesFor.mock.calls.map(([bound]) => bound.sessionId)).toEqual(['s-1', 's-2']);
    // The adapter never opens inbox storage: every byte came from the injected operation.
    expect(inboxAccess).not.toHaveBeenCalled();
    inboxAccess.mockRestore();
  });

  it('refuses a directory answer that belongs to a different session', async () => {
    const { adapter: claude, services } = adapter({ 's-1': BINDINGS['s-2'] });
    await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    expect(services.reads.size).toBe(0);
  });

  it('denies a foreign session ID to a second authenticated caller without disclosure', async () => {
    const { adapter: claude, services, state } = adapter();
    services.services(BINDINGS['s-1']);
    services.reads.get('binding-1')!.next.push({ kind: 'batch', batch: batch('secret-token', '{"body":"private"}') });
    state.tokens.set(S1, retained('retained-secret'));
    const foreign = { credential: CREDENTIAL_B, sessionId: 's-1' };

    const results = [
      await claude.pull(foreign, { maxBytes: 4096 }),
      await claude.read(foreign, { maxBytes: 4096 }),
      await claude.status(foreign),
      await claude.send(foreign, { body: 'hello' }),
      await claude.mode(foreign),
      await claude.setMode(foreign, { commandId: 'command-1', expectedVersion: 1, requested: 'async', issuedAt: '2026-09-25T00:00:00Z' }),
      await claude.pending(foreign),
    ];
    for (const result of results) expect(result).toEqual({ kind: 'refused', code: 'session_not_bound' });
    // Indistinguishable from a session that does not exist.
    await expect(claude.read({ credential: CREDENTIAL_B, sessionId: 'no-such-session' }, { maxBytes: 1 }))
      .resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    const disclosed = JSON.stringify(results);
    for (const secret of ['private', 'secret-token', 'retained-secret', 'binding-1', 'sync', 'agent-']) expect(disclosed).not.toContain(secret);
    expect(services.reads.get('binding-1')!.calls).toEqual([]);
    expect(services.sends).toEqual([]);
    expect(state.tokens.get(S1)).toEqual(retained('retained-secret'));
  });

  it('refuses an unauthenticated caller before resolving any session', async () => {
    const sessions = { resolve: vi.fn(directory().resolve) };
    const claude = createClaudeSessionAdapter({
      authenticator: authenticator(), sessions, state: memoryState(), services: fakeServices().services,
    });
    await expect(claude.read({ credential: 'C'.repeat(43), sessionId: 's-1' }, { maxBytes: 1 }))
      .resolves.toEqual({ kind: 'refused', code: 'unauthorized' });
    expect(sessions.resolve).not.toHaveBeenCalled();
  });

  it('amendment wrong-implementation test: a second PostToolUse pull records no acknowledgement before the agent’s next Khala call', async () => {
    const { inbox, claude, base } = inboxAdapter(['{"body":"released at PostToolUse"}']);

    const first = await claude.pull(A1, { maxBytes: 4096 });
    const second = await claude.pull(A1, { maxBytes: 4096 });
    expect(JSON.stringify(first)).toContain('released at PostToolUse');
    // The inbox replays its one outstanding batch until the agent acknowledges it.
    expect(second).toEqual(first);
    expect(inbox.log).toEqual([]);
    expect(inbox.calls.map(call => call.acknowledgeToken)).toEqual([undefined, undefined]);

    await expect(claude.send(A1, { body: 'reply' })).resolves.toMatchObject({ kind: 'accepted' });
    expect(inbox.log).toEqual([{ token: 'fresh-token-1', outcome: 'recorded' }]);
    expect(base.sends).toEqual([{ bindingId: 'binding-1', acknowledgeToken: 'fresh-token-1' }]);
    expect(JSON.stringify([first, second])).not.toContain('fresh-token-1');
  });

  it('never acknowledges on a hook pull, even with tokens retained', async () => {
    const { adapter: claude, services, state } = adapter();
    services.services(BINDINGS['s-1']);
    state.tokens.set(S1, retained('retained-before-pull'));
    const read = services.reads.get('binding-1')!;
    read.next.push({ kind: 'batch', batch: batch('pulled-token') });

    await claude.pull(A1, { maxBytes: 4096 });
    await claude.pull(A1, { maxBytes: 4096 });
    expect(read.calls).toEqual([{ bindingId: 'binding-1', maxBytes: 4096 }, { bindingId: 'binding-1', maxBytes: 4096 }]);
    // The pull's own token replaced its generation's entry; nothing was acknowledged.
    expect(state.tokens.get(S1)).toEqual(retained('pulled-token'));
  });

  it('acknowledges two retained tokens with one agent call, one readBatch per retained scope', async () => {
    const services = fakeServices();
    const state = memoryState();
    let current = BINDINGS['s-1'];
    const servicesFor = vi.fn(services.services);
    const claude = createClaudeSessionAdapter({
      authenticator: authenticator(), state, services: servicesFor,
      sessions: { resolve: async (_principal, claim) => claim.sessionId === 's-1' ? current : null },
    });
    services.services(current);
    const read = services.reads.get('binding-1')!;
    read.next.push({ kind: 'batch', batch: batch('generation-1-token') });
    await claude.pull(A1, { maxBytes: 64 });
    current = binding('s-1', 'binding-1', 2);
    read.next.push({ kind: 'batch', batch: batch('generation-2-token') });
    await claude.pull(A1, { maxBytes: 64 });
    expect(state.tokens.get(S1)).toEqual([{ generation: 1, token: 'generation-1-token' }, { generation: 2, token: 'generation-2-token' }]);
    servicesFor.mockClear();

    await expect(claude.status(A1)).resolves.toEqual({ kind: 'status', acknowledged: 2 });
    expect(read.calls.slice(2)).toEqual([
      { bindingId: 'binding-1', maxBytes: 0, acknowledgeToken: 'generation-1-token' },
      { bindingId: 'binding-1', maxBytes: 0, acknowledgeToken: 'generation-2-token' },
    ]);
    // Each token went to its own generation's scope, never onto the other's call.
    expect(servicesFor.mock.calls.map(([bound]) => bound.generation)).toEqual([2, 1]);
    expect(state.tokens.has(S1)).toBe(false);
    await expect(claude.status(A1)).resolves.toEqual({ kind: 'status', acknowledged: 0 });
    expect(read.calls).toHaveLength(4);
  });

  it('after the session is replaced: old token is stale_generation, the release redelivers once, a replayed fresh token is duplicate', async () => {
    const { inbox, claude, state } = inboxAdapter(['{"body":"survives the restart"}']);
    await claude.pull(A1, { maxBytes: 4096 });
    inbox.replace();

    const redelivered = await claude.pull(A1, { maxBytes: 4096 });
    expect(JSON.stringify(redelivered)).toContain('survives the restart');
    expect(state.tokens.get(S1)).toEqual([{ generation: 1, token: 'fresh-token-1' }, { generation: 2, token: 'fresh-token-2' }]);

    // The server stops after the inbox commits but before the retained set is cleared.
    const beforeCrash = state.tokens.get(S1)!;
    await expect(claude.status(A1)).resolves.toEqual({ kind: 'status', acknowledged: 2 });
    expect(inbox.log).toEqual([
      { token: 'fresh-token-1', outcome: 'stale_generation' },
      { token: 'fresh-token-2', outcome: 'recorded' },
    ]);
    await expect(claude.pull(A1, { maxBytes: 4096 })).resolves.toEqual({ kind: 'empty' });

    state.tokens.set(S1, beforeCrash.filter(entry => entry.generation === 2));
    await expect(claude.read(A1, { maxBytes: 4096 })).resolves.toEqual({ kind: 'empty' });
    expect(inbox.log.at(-1)).toEqual({ token: 'fresh-token-2', outcome: 'duplicate' });
    expect(state.tokens.has(S1)).toBe(false);
  });

  it('acknowledges retained tokens on a mode read, which is an agent call too', async () => {
    const { inbox, claude } = inboxAdapter(['{"body":"pulled before a mode check"}']);
    await claude.pull(A1, { maxBytes: 4096 });
    await expect(claude.mode(A1)).resolves.toMatchObject({ kind: 'mode' });
    expect(inbox.log).toEqual([{ token: 'fresh-token-1', outcome: 'recorded' }]);
  });

  it('reports hook boundary state without acknowledging a retained token', async () => {
    const { inbox, claude } = inboxAdapter(['{"body":"pulled before a hook check"}']);
    await claude.pull(A1, { maxBytes: 4096 });
    await expect(claude.hook(A1)).resolves.toMatchObject({ kind: 'hook' });
    // A hook that used `mode` here would acknowledge a batch the model may not have seen.
    expect(inbox.log).toEqual([]);
  });

  it('gives the effective mode and the fence watcher window, and no window outside steer and sync', async () => {
    const { adapter: claude, services, state } = adapter();
    const envelope = vi.spyOn(state, 'envelope');
    services.services(BINDINGS['s-1']);
    await expect(claude.hook(A1)).resolves.toEqual({ kind: 'hook', effective: null, watchSeconds: null });
    services.mode.value = 'sync';
    await expect(claude.hook(A1)).resolves.toEqual({ kind: 'hook', effective: 'sync', watchSeconds: 3000 });
    services.mode.value = 'steer';
    services.watch.value = null;
    await expect(claude.hook(A1)).resolves.toEqual({ kind: 'hook', effective: 'steer', watchSeconds: null });
    services.watch.value = { seconds: 0 };
    await expect(claude.hook(A1)).resolves.toEqual({ kind: 'hook', effective: 'steer', watchSeconds: null });
    services.watch.value = { seconds: 60 };
    services.mode.value = 'async';
    await expect(claude.hook(A1)).resolves.toEqual({ kind: 'hook', effective: 'async', watchSeconds: null });
    // Without batch-token handoff every hook pull is refused, so hooks deliver nothing.
    services.mode.value = 'steer';
    services.capabilities.value = capabilities('unknown');
    await expect(claude.hook(A1)).resolves.toEqual({ kind: 'hook', effective: null, watchSeconds: null });
    expect(envelope).not.toHaveBeenCalled();
    expect(services.reads.get('binding-1')!.calls).toEqual([]);
    await expect(claude.hook({ credential: CREDENTIAL_B, sessionId: 's-1' })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
  });

  it('keeps an agent read’s own batch token for the next agent call and keeps no local acknowledgement', async () => {
    const { adapter: claude, services } = adapter();
    services.services(BINDINGS['s-1']);
    const read = services.reads.get('binding-1')!;
    const returned = batch('opaque.token_1');
    read.next.push({ kind: 'batch', batch: returned });

    const first = await claude.read(A1, { maxBytes: 4096 });
    expect(JSON.stringify(first)).not.toContain('opaque.token_1');
    await claude.read(A1, { maxBytes: 4096 });
    await claude.read(A1, { maxBytes: 4096 });

    expect(read.calls).toEqual([
      { bindingId: 'binding-1', maxBytes: 4096 },
      { bindingId: 'binding-1', maxBytes: 4096, acknowledgeToken: 'opaque.token_1' },
      { bindingId: 'binding-1', maxBytes: 4096 },
    ]);
    // Acknowledgement is only ever the forwarded token: no release filtering or dedupe on this side.
    read.next.push({ kind: 'batch', batch: returned });
    await expect(claude.read(A1, { maxBytes: 4096 })).resolves.toMatchObject({ kind: 'batch' });
  });

  it('attaches the retained token to exactly one of racing agent calls, and never to a racing pull', async () => {
    const { adapter: claude, services } = adapter();
    services.services(BINDINGS['s-1']);
    const read = services.reads.get('binding-1')!;
    read.next.push({ kind: 'batch', batch: batch('race-token') });
    await claude.pull(A1, { maxBytes: 4096 });

    await Promise.all([
      claude.send(A1, { body: 'one' }),
      claude.read(A1, { maxBytes: 4096 }),
      claude.pull(A1, { maxBytes: 4096 }),
      claude.setMode(A1, { commandId: 'command-1', expectedVersion: 1, requested: 'steer', issuedAt: '2026-09-25T00:00:00Z' }),
      claude.status(A1),
      claude.mode(A1),
      claude.send(A1, { body: 'two' }),
      claude.read(A1, { maxBytes: 4096 }),
    ]);
    const carried = [
      ...services.sends.map(call => call.acknowledgeToken),
      ...read.calls.slice(1).map(call => call.acknowledgeToken),
      ...services.modeSets.map(call => call.acknowledgeToken),
    ].filter(token => token !== undefined);
    expect(carried).toEqual(['race-token']);
  });

  it('never exposes a token in outcomes, refusals, or another session', async () => {
    const { adapter: claude, services } = adapter();
    services.services(BINDINGS['s-1']);
    services.reads.get('binding-1')!.next.push({ kind: 'batch', batch: batch('leak-canary-token') });
    const outcomes = [
      await claude.pull(A1, { maxBytes: 4096 }),
      await claude.read(A2, { maxBytes: 4096 }),
      await claude.send(A2, { body: 'hi' }),
      await claude.status(A2),
      await claude.pending(A2),
    ];
    expect(JSON.stringify(outcomes)).not.toContain('leak-canary-token');
    expect(services.reads.get('binding-2')!.calls).toEqual([{ bindingId: 'binding-2', maxBytes: 4096 }]);
    expect(services.sends).toEqual([{ bindingId: 'binding-2' }]);
    // The token is still retained for its own session only.
    await claude.read(A1, { maxBytes: 4096 });
    expect(services.reads.get('binding-1')!.calls.at(-1)).toMatchObject({ acknowledgeToken: 'leak-canary-token' });
  });

  it('delivers a send piggyback batch token-free and forwards its token on the next call', async () => {
    const { adapter: claude, services } = adapter();
    services.services(BINDINGS['s-1']);
    services.piggyback.push(batch('piggyback-token', '{"body":"arrived during send"}'));

    const sent = await claude.send(A1, { body: 'hello' });
    expect(sent).toMatchObject({ kind: 'accepted', clientTxnId: 'txn-12345678' });
    expect(JSON.stringify(sent)).toContain('arrived during send');
    expect(JSON.stringify(sent)).not.toContain('piggyback-token');
    await claude.setMode(A1, { commandId: 'command-1', expectedVersion: 1, requested: 'async', issuedAt: '2026-09-25T00:00:00Z' });
    expect(services.modeSets).toEqual([{ bindingId: 'binding-1', acknowledgeToken: 'piggyback-token' }]);
  });

  it('never retains the token of a batch it could not deliver', async () => {
    const { adapter: claude, services } = adapter();
    services.services(BINDINGS['s-1']);
    const read = services.reads.get('binding-1')!;
    const unrenderable = { token: 'undeliverable-token', items: [] } as never;

    read.next.push({ kind: 'batch', batch: unrenderable });
    await expect(claude.pull(A1, { maxBytes: 64 })).resolves.toEqual({ kind: 'refused', code: 'unavailable' });
    services.piggyback.push(unrenderable);
    // The send's own outcome survives; only its undeliverable batch is dropped.
    await expect(claude.send(A1, { body: 'hello' })).resolves.toEqual({
      kind: 'accepted', clientTxnId: 'txn-12345678', eventId: 'event-1',
    });
    await claude.read(A1, { maxBytes: 64 });
    expect(read.calls.map(call => call.acknowledgeToken)).toEqual([undefined, undefined]);
    expect(services.sends).toEqual([{ bindingId: 'binding-1' }]);
  });

  it('fences a replaced generation’s token and never carries it on the new generation’s call', async () => {
    const services = fakeServices();
    const state = memoryState();
    let current = BINDINGS['s-1'];
    const claude = createClaudeSessionAdapter({
      authenticator: authenticator(), state,
      services: bound => bound.generation === current.generation ? services.services(bound) : {
        ...services.services(bound),
        read: { read: async () => { throw new CliError('binding_not_held'); } },
      },
      sessions: { resolve: async (_principal, claim) => claim.sessionId === 's-1' ? current : null },
    });
    services.services(current);
    services.reads.get('binding-1')!.next.push({ kind: 'batch', batch: batch('generation-1-token') });
    await claude.pull(A1, { maxBytes: 64 });
    current = binding('s-1', 'binding-1', 2);
    await claude.read(A1, { maxBytes: 64 });
    expect(services.reads.get('binding-1')!.calls.at(-1)).toEqual({ bindingId: 'binding-1', maxBytes: 64 });
    expect(state.tokens.has(S1)).toBe(false);
  });

  it('fails closed without payload for stale bindings, bad tokens, unavailable runtime, and empty batches', async () => {
    const { adapter: claude, services, state } = adapter();
    services.services(BINDINGS['s-1']);
    const read = services.reads.get('binding-1')!;
    const port = read.port.read as ReturnType<typeof vi.fn>;

    port.mockRejectedValueOnce(new CliError('binding_not_held'));
    await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'binding_not_held' });

    state.tokens.set(S1, retained('not-yet-committed'));
    port.mockRejectedValueOnce(new CliError('invalid_input'));
    await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'invalid_request' });
    // A failed call committed nothing: the next agent call carries the token again.
    expect(state.tokens.get(S1)).toEqual(retained('not-yet-committed'));

    port.mockRejectedValueOnce(new Error('connection refused: payload secret-bytes'));
    const unavailable = await claude.read(A1, { maxBytes: 1 });
    expect(unavailable).toEqual({ kind: 'refused', code: 'unavailable' });

    await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'empty' });
    expect(read.calls.at(-1)).toEqual({ bindingId: 'binding-1', maxBytes: 1, acknowledgeToken: 'not-yet-committed' });
    expect(state.tokens.size).toBe(0);
  });

  it('keeps unproven capabilities unproven and permits handoff only for batch_token_next_call', async () => {
    for (const acknowledgement of ['unknown', 'unsupported'] as const) {
      const { adapter: claude, services, state } = adapter();
      services.capabilities.value = capabilities(acknowledgement);
      services.services(BINDINGS['s-1']);
      state.tokens.set(S1, retained('retained'));
      await expect(claude.pull(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'unproven' });
      await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'unproven' });
      await expect(claude.status(A1)).resolves.toEqual({ kind: 'status', acknowledged: 0 });
      await claude.send(A1, { body: 'hello' });
      expect(services.reads.get('binding-1')!.calls).toEqual([]);
      expect(services.sends).toEqual([{ bindingId: 'binding-1' }]);
      expect(state.tokens.get(S1)).toEqual(retained('retained'));
      await expect(claude.mode(A1)).resolves.toMatchObject({
        kind: 'mode', requested: 'sync', acknowledgement,
        support: { steer: 'unproven', sync: 'unproven', async: 'unproven' },
      });
    }
  });

  it('observes the pending signal as notification state only', async () => {
    const { adapter: claude, services, state } = adapter();
    const envelope = vi.spyOn(state, 'envelope');
    services.services(BINDINGS['s-1']);
    await expect(claude.pending(A1)).resolves.toEqual({ kind: 'idle' });
    services.pending.value = true;
    await expect(claude.pending(A1)).resolves.toEqual({ kind: 'pending' });
    // A port that tries to smuggle a batch or token out gets exactly one bit through.
    const leaky = createClaudeSessionAdapter({
      authenticator: authenticator(), sessions: directory(), state,
      services: bound => ({
        ...services.services(bound),
        pending: async () => ({ pending: true, batchToken: 'smuggled', batch: batch('smuggled') }) as never,
      }),
    });
    await expect(leaky.pending(A1)).resolves.toEqual({ kind: 'pending' });
    // It only looks at retained state: nothing is committed or retained.
    for (const call of envelope.mock.calls) expect(call[0]).toEqual({ principalId: 'principal-a', bindingId: 'binding-1' });
    expect(services.reads.get('binding-1')!.calls).toEqual([]);
    expect(state.tokens.size).toBe(0);
  });

  it('reports nothing pending while a delivered batch awaits acknowledgement, so a watcher cannot re-wake for it', async () => {
    const { inbox, claude, base } = inboxAdapter(['{"body":"delivered, not yet acknowledged"}', '{"body":"next"}']);
    base.pending.value = true;
    await expect(claude.pull(A1, { maxBytes: 4096 })).resolves.toMatchObject({ kind: 'batch' });
    await expect(claude.pending(A1)).resolves.toEqual({ kind: 'idle' });
    expect(inbox.log).toEqual([]);
    // The agent's next Khala call acknowledges it; the next release is pending again.
    await claude.status(A1);
    await expect(claude.pending(A1)).resolves.toEqual({ kind: 'pending' });
  });
});
