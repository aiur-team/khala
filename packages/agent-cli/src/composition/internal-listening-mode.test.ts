import { describe, expect, it } from 'vitest';
import { type CommandId, type SessionBinding, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import type { GrantedDescriptor } from '@khala/contracts/internal/descriptor';
import { claudeCapabilities } from '@khala/harnesses/claude/capabilities';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import { initialListeningModeControl, listeningModeView } from '@khala/policy/listening-mode/store';
import {
  AGENT_HARNESS_PATH, AGENT_LISTENING_MODE_PATH, type LocalHarnessCapabilities, createInternalListeningMode,
} from './internal-listening-mode.js';

const limits = decodeDeliveryLimits({ maxPayloadBytes: 65_536, maxSelectionEvents: 32 });
if (!limits.ok) throw new Error('limits');
const TRUSTED = interactiveCodexCapabilities('0.156.1', limits.value, { state: 'trusted' });
const UNREVIEWED = interactiveCodexCapabilities('0.156.1', limits.value, { state: 'awaiting_hook_review', reason: 'Review the hooks.' });

const binding: SessionBinding = {
  v: 1, bindingId: 'binding-a' as SessionBinding['bindingId'], ownerId: 'owner-a' as SessionBinding['ownerId'],
  agentParticipantId: 'participant-a' as SessionBinding['agentParticipantId'], deviceId: 'device-a' as SessionBinding['deviceId'],
  harness: 'codex', sessionId: 'session-a', generation: 3,
};
const descriptor = { bindingId: binding.bindingId, bindingCapability: 'cap' } as unknown as GrantedDescriptor;

type Server = { requested: 'steer' | 'sync' | 'async'; version: number; status: number; binding: SessionBinding; posts: unknown[] };

function server(overrides: Partial<Server> = {}): Server {
  return { requested: 'steer', version: 2, status: 200, binding, posts: [], ...overrides };
}

function modes(state: Server, capabilities: LocalHarnessCapabilities, held: GrantedDescriptor | null = descriptor) {
  return createInternalListeningMode({
    descriptor: () => held,
    capabilities,
    async call(_descriptor, target, init) {
      expect(target).toBe(AGENT_LISTENING_MODE_PATH);
      const control = { ...initialListeningModeControl(state.binding, null), requested: state.requested, version: state.version };
      if (init.method === 'POST') {
        state.posts.push(init.body);
        const body = init.body as { commandId: string; requested: 'steer' | 'sync' | 'async'; expectedVersion: number };
        state.requested = body.requested;
        state.version += 1;
        return {
          status: state.status,
          body: {
            v: 1, commandId: body.commandId, bindingId: state.binding.bindingId, generation: state.binding.generation,
            outcome: 'applied', version: state.version, requested: state.requested, effective: null, reason: 'capabilities_unavailable',
          },
        };
      }
      // The server projects without the local harness; the client must replace, never trust, that projection.
      return { status: state.status, body: { v: 1, binding: state.binding, view: { ...listeningModeView(control, null), effective: 'async' } } };
    },
  });
}

describe('internal listening mode', () => {
  it('projects the server record through the local harness claim', async () => {
    expect(await modes(server(), async () => TRUSTED).status()).toEqual({
      v: 1, bindingId: binding.bindingId, generation: 3, effective: 'steer',
    });
    // Without a receipt proof async is not usable, whatever the server said.
    expect((await modes(server({ requested: 'async' }), async () => TRUSTED).status())?.effective).toBeNull();
  });

  it('claims nothing it cannot inspect: no claim, an untrusted hook, a failing inspection, or another harness', async () => {
    for (const capabilities of [
      async () => null,
      async () => UNREVIEWED,
      async () => { throw new Error('codex missing'); },
      async () => claudeCapabilities(null, limits.value),
    ] satisfies LocalHarnessCapabilities[]) {
      expect((await modes(server(), capabilities).status())?.effective).toBeNull();
    }
    const read = await modes(server(), async () => null).read();
    expect(read).toMatchObject({ ok: true, view: { requested: 'steer', effective: null, effectiveReason: 'capabilities_unavailable' } });
  });

  it('refuses an answer for another binding and reports an ungranted or revoked descriptor', async () => {
    const foreign = { ...binding, bindingId: 'binding-b' as SessionBinding['bindingId'] };
    expect(await modes(server({ binding: foreign }), async () => TRUSTED).status()).toBeNull();
    expect(await modes(server(), async () => TRUSTED, null).read()).toEqual({ ok: false, code: 'unavailable' });
    expect(await modes(server({ status: 401 }), async () => TRUSTED).read()).toEqual({ ok: false, code: 'binding_revoked' });
  });

  it('reports the harness observation once per process, and a failed report changes nothing', async () => {
    const reports: unknown[] = [];
    const control = { ...initialListeningModeControl(binding, null), requested: 'sync' as const, version: 2 };
    const client = createInternalListeningMode({
      descriptor: () => descriptor,
      capabilities: async () => TRUSTED,
      observation: async () => ({ version: '0.156.1', hookReview: 'trusted' }),
      async call(_descriptor, target, init) {
        if (target === AGENT_HARNESS_PATH) {
          reports.push(init.body);
          throw new Error('server went away');
        }
        return { status: 200, body: { v: 1, binding, view: listeningModeView(control, null) } };
      },
    });
    expect((await client.status())?.effective).toBe('sync');
    expect((await client.status())?.effective).toBe('sync');
    expect(reports).toEqual([{ v: 1, version: '0.156.1', hookReview: 'trusted' }]);
  });

  it('sets only its own binding and re-projects the written record', async () => {
    const state = server({ requested: 'sync' });
    const result = await modes(state, async () => TRUSTED).set({
      commandId: 'cmd-1' as CommandId, expectedVersion: 2, requested: 'steer', issuedAt: '2026-09-26T00:00:00.000Z',
    });
    expect(state.posts).toEqual([{ v: 1, commandId: 'cmd-1', expectedVersion: 2, requested: 'steer', issuedAt: '2026-09-26T00:00:00.000Z' }]);
    expect(result).toMatchObject({ outcome: 'applied', version: 3, requested: 'steer', effective: 'steer', reason: null });
  });
});
