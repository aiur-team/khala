import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import {
  CREDENTIAL_A, CREDENTIAL_B, authenticator, binding, capabilities, fakeInbox, fakeServices, memoryState,
} from '../fixtures/claude.js';
import { createClaudeSessionAdapter, type ClaudeBindingServices } from './claude-session.js';

// Read-receipt conformance for the interactive Claude route: hooks deliver, and only the
// agent's own next Khala call carries the batch token back. `inbox.log` is what the
// shared inbox would turn into `agent_acknowledged`, so it is the only success signal.

const CALL = { credential: CREDENTIAL_A, sessionId: 's-1' };
const S1 = JSON.stringify(['principal-a', 'binding-1']);

function route(bodies: readonly string[], options: Readonly<{ dropToken?: boolean }> = {}) {
  const inbox = fakeInbox(bodies);
  const base = fakeServices();
  const state = memoryState();
  const services = (bound: SessionBinding): ClaudeBindingServices => {
    const read = inbox.port(bound.generation);
    return {
      ...base.services(bound),
      // A broken route that loses the pending token: the inbox never sees it.
      read: options.dropToken === true ? { read: (input) => read.read({ ...input, acknowledgeToken: undefined }) } : read,
      async send(input) {
        if (input.acknowledgeToken !== undefined && options.dropToken !== true) inbox.acknowledge(bound.generation, input.acknowledgeToken);
        return base.services(bound).send({ body: input.body });
      },
    };
  };
  const claude = createClaudeSessionAdapter({
    authenticator: authenticator(), state, services,
    sessions: {
      resolve: async (principal, claim) => principal.principalId === 'principal-a' && claim.sessionId === 's-1'
        ? binding('s-1', 'binding-1', inbox.generation) : null,
    },
  });
  return { inbox, state, claude };
}

const recorded = (inbox: ReturnType<typeof fakeInbox>) => inbox.log.filter(entry => entry.outcome === 'recorded');

describe('Claude read-receipt conformance', () => {
  it.each(['read', 'send', 'status', 'mode'] as const)('acknowledges only on the agent’s next %s call', async next => {
    const { inbox, claude } = route(['{"body":"hello"}']);
    // Hook delivery at a tool boundary and at Stop, repeated: no receipt.
    await claude.pull(CALL, { maxBytes: 4096 });
    await claude.pull(CALL, { maxBytes: 4096 });
    expect(inbox.log).toEqual([]);
    if (next === 'read') await claude.read(CALL, { maxBytes: 4096 });
    if (next === 'send') await claude.send(CALL, { body: 'reply' });
    if (next === 'status') await claude.status(CALL);
    if (next === 'mode') await claude.mode(CALL);
    expect(recorded(inbox)).toEqual([{ token: 'fresh-token-1', outcome: 'recorded' }]);
  });

  it('treats no later call as neutral: the batch replays and nothing is acknowledged', async () => {
    const { inbox, claude } = route(['{"body":"hello"}']);
    const first = await claude.pull(CALL, { maxBytes: 4096 });
    await expect(claude.pull(CALL, { maxBytes: 4096 })).resolves.toEqual(first);
    expect(inbox.log).toEqual([]);
    // A watcher must not re-wake the idle session for an unacknowledged delivered batch.
    await expect(claude.pending(CALL)).resolves.toEqual({ kind: 'idle' });
  });

  it('wrong implementation: a route that omits the pending token on the next call records no acknowledgement', async () => {
    const { inbox, claude } = route(['{"body":"hello"}'], { dropToken: true });
    await claude.pull(CALL, { maxBytes: 4096 });
    await claude.send(CALL, { body: 'reply' });
    await claude.read(CALL, { maxBytes: 4096 });
    expect(inbox.log).toEqual([]);
  });

  it('refuses another session or caller and never lets it acknowledge', async () => {
    const { inbox, claude } = route(['{"body":"hello"}']);
    await claude.pull(CALL, { maxBytes: 4096 });
    await expect(claude.status({ ...CALL, sessionId: 's-2' })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    await expect(claude.status({ credential: CREDENTIAL_B, sessionId: 's-1' })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    expect(inbox.log).toEqual([]);
  });

  it('fences a replaced generation on reconnect and records a replayed token as a duplicate', async () => {
    const { inbox, claude, state } = route(['{"body":"hello"}']);
    await claude.pull(CALL, { maxBytes: 4096 });
    inbox.replace();
    await claude.pull(CALL, { maxBytes: 4096 });
    await claude.status(CALL);
    expect(inbox.log).toEqual([
      { token: 'fresh-token-1', outcome: 'stale_generation' },
      { token: 'fresh-token-2', outcome: 'recorded' },
    ]);
    // The server stopped after the inbox committed, before the retained set cleared.
    state.tokens.set(S1, [{ generation: 2, token: 'fresh-token-2' }]);
    await claude.status(CALL);
    expect(recorded(inbox)).toHaveLength(1);
    expect(inbox.log.at(-1)).toEqual({ token: 'fresh-token-2', outcome: 'duplicate' });
  });

  it('serializes racing agent calls so exactly one carries the token', async () => {
    const { inbox, claude } = route(['{"body":"hello"}']);
    await claude.pull(CALL, { maxBytes: 4096 });
    await Promise.all([claude.status(CALL), claude.read(CALL, { maxBytes: 4096 }), claude.send(CALL, { body: 'x' })]);
    expect(recorded(inbox)).toHaveLength(1);
  });

  it('puts no token in any outcome and grants no handoff without batch_token_next_call', async () => {
    const { claude } = route(['{"body":"hello"}']);
    const outcomes = [
      await claude.pull(CALL, { maxBytes: 4096 }), await claude.read(CALL, { maxBytes: 4096 }),
      await claude.send(CALL, { body: 'x' }), await claude.status(CALL), await claude.mode(CALL),
    ];
    expect(JSON.stringify(outcomes)).not.toMatch(/fresh-token/);

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
