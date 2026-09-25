import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CliError } from '../cli/errors.js';
import {
  BINDINGS, CREDENTIAL_A, CREDENTIAL_B, authenticator, batch, binding, capabilities, directory, fakeServices, memoryState,
} from '../fixtures/claude.js';
import { createClaudeSessionAdapter } from './claude-session.js';

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
    state.tokens.set(JSON.stringify(['principal-a', 'binding-1', 1]), 'retained-secret');
    const foreign = { credential: CREDENTIAL_B, sessionId: 's-1' };

    const results = [
      await claude.read(foreign, { maxBytes: 4096 }),
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
    expect(state.tokens.get(JSON.stringify(['principal-a', 'binding-1', 1]))).toBe('retained-secret');
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

  it('forwards the exact returned token once on the next Khala call and keeps no local acknowledgement', async () => {
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

  it('attaches the retained token to exactly one of racing send, pull, and mode-control calls', async () => {
    const { adapter: claude, services } = adapter();
    services.services(BINDINGS['s-1']);
    const read = services.reads.get('binding-1')!;
    read.next.push({ kind: 'batch', batch: batch('race-token') });
    await claude.read(A1, { maxBytes: 4096 });

    await Promise.all([
      claude.send(A1, { body: 'one' }),
      claude.read(A1, { maxBytes: 4096 }),
      claude.setMode(A1, { commandId: 'command-1', expectedVersion: 1, requested: 'steer', issuedAt: '2026-09-25T00:00:00Z' }),
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
      await claude.read(A1, { maxBytes: 4096 }),
      await claude.read(A2, { maxBytes: 4096 }),
      await claude.send(A2, { body: 'hi' }),
      await claude.mode(A1),
      await claude.pending(A2),
    ];
    expect(JSON.stringify(outcomes)).not.toContain('leak-canary-token');
    expect(services.reads.get('binding-2')!.calls).toEqual([{ bindingId: 'binding-2', maxBytes: 4096 }]);
    expect(services.sends).toEqual([{ bindingId: 'binding-2' }]);
    // The token is still retained for its own session only.
    await claude.read(A1, { maxBytes: 4096 });
    expect(services.reads.get('binding-1')!.calls.at(-1)).toMatchObject({ acknowledgeToken: 'leak-canary-token' });
  });

  it('does not carry a token across a generation change', async () => {
    const services = fakeServices();
    const state = memoryState();
    let current = BINDINGS['s-1'];
    const claude = createClaudeSessionAdapter({
      authenticator: authenticator(), state, services: services.services,
      sessions: { resolve: async (_principal, claim) => claim.sessionId === 's-1' ? current : null },
    });
    services.services(current);
    services.reads.get('binding-1')!.next.push({ kind: 'batch', batch: batch('generation-1-token') });
    await claude.read(A1, { maxBytes: 64 });
    current = binding('s-1', 'binding-1', 2);
    await claude.read(A1, { maxBytes: 64 });
    expect(services.reads.get('binding-1')!.calls.at(-1)).toEqual({ bindingId: 'binding-1', maxBytes: 64 });
  });

  it('fails closed without payload for stale bindings, bad tokens, unavailable runtime, and empty batches', async () => {
    const { adapter: claude, services, state } = adapter();
    services.services(BINDINGS['s-1']);
    const read = services.reads.get('binding-1')!;
    const port = read.port.read as ReturnType<typeof vi.fn>;

    port.mockRejectedValueOnce(new CliError('binding_not_held'));
    await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'binding_not_held' });

    state.tokens.set(JSON.stringify(['principal-a', 'binding-1', 1]), 'not-a-real-token');
    port.mockRejectedValueOnce(new CliError('invalid_input'));
    await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'invalid_request' });
    // The token was attached once and is not retried.
    expect(state.tokens.size).toBe(0);

    port.mockRejectedValueOnce(new Error('connection refused: payload secret-bytes'));
    const unavailable = await claude.read(A1, { maxBytes: 1 });
    expect(unavailable).toEqual({ kind: 'refused', code: 'unavailable' });

    await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'empty' });
    expect(state.tokens.size).toBe(0);
  });

  it('keeps unproven capabilities unproven and permits handoff only for batch_token_next_call', async () => {
    for (const acknowledgement of ['unknown', 'unsupported'] as const) {
      const { adapter: claude, services, state } = adapter();
      services.capabilities.value = capabilities(acknowledgement);
      services.services(BINDINGS['s-1']);
      state.tokens.set(JSON.stringify(['principal-a', 'binding-1', 1]), 'retained');
      await expect(claude.read(A1, { maxBytes: 1 })).resolves.toEqual({ kind: 'refused', code: 'unproven' });
      await claude.send(A1, { body: 'hello' });
      expect(services.reads.get('binding-1')!.calls).toEqual([]);
      expect(services.sends).toEqual([{ bindingId: 'binding-1' }]);
      expect(state.tokens.get(JSON.stringify(['principal-a', 'binding-1', 1]))).toBe('retained');
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
    expect(envelope).not.toHaveBeenCalled();
    expect(services.reads.get('binding-1')!.calls).toEqual([]);
    expect(state.tokens.size).toBe(0);
  });
});
