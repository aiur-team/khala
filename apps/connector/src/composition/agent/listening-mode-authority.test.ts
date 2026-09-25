import type {
  BindingId,
  CommandId,
  HarnessCapabilities,
  ListeningModeCommand,
  SessionBinding,
} from '@khala/contracts/delivery/index';
import type { ListeningModeStore } from '@khala/policy/listening-mode/store';
import { createListeningModeService } from '@khala/policy/listening-mode/store';
import { describe, expect, it } from 'vitest';
import {
  createAgentListeningModeAuthority,
  type AgentListeningModeContextPort,
} from './listening-mode-authority';

const held = (generation = 3): SessionBinding => ({
  v: 1,
  bindingId: 'binding-held' as SessionBinding['bindingId'],
  ownerId: 'owner-held' as SessionBinding['ownerId'],
  agentParticipantId: 'agent-held' as SessionBinding['agentParticipantId'],
  deviceId: 'device-held' as SessionBinding['deviceId'],
  harness: 'codex',
  sessionId: 'session-held',
  generation,
});

const unavailableCapabilities = null as HarnessCapabilities | null;

function context(current: SessionBinding, status: 'active' | 'revoked' = 'active'): AgentListeningModeContextPort {
  return {
    async resolve(bindingId: BindingId) {
      expect(bindingId).toBe(held().bindingId);
      return { kind: 'current', binding: current, status, capabilities: unavailableCapabilities };
    },
  };
}

function trackingStore() {
  let reads = 0;
  const store: ListeningModeStore = {
    async read() { reads += 1; return { kind: 'unavailable' }; },
    async compareAndSet() { return { kind: 'unavailable' }; },
  };
  return { store, reads: () => reads };
}

const setInput = {
  commandId: 'set-mode' as CommandId,
  expectedVersion: 1,
  requested: 'steer' as const,
  issuedAt: '2026-09-24T12:00:00Z',
};

describe('trusted agent listening-mode composition', () => {
  it('constructs exact held-binding authority and refuses a stale held generation before storage', async () => {
    const tracked = trackingStore();
    const application = createAgentListeningModeAuthority(
      held(3),
      context(held(4)),
      createListeningModeService(tracked.store),
    );

    await expect(application.read()).resolves.toEqual({ ok: false, code: 'stale_binding' });
    await expect(application.set(setInput)).resolves.toMatchObject({ outcome: 'refused', reason: 'stale_binding' });
    expect(tracked.reads()).toBe(0);
  });

  it('refuses captured authority after revocation before storage', async () => {
    const tracked = trackingStore();
    const application = createAgentListeningModeAuthority(
      held(),
      context(held(), 'revoked'),
      createListeningModeService(tracked.store),
    );

    await expect(application.read()).resolves.toEqual({ ok: false, code: 'binding_revoked' });
    await expect(application.set(setInput)).resolves.toMatchObject({ outcome: 'refused', reason: 'binding_revoked' });
    expect(tracked.reads()).toBe(0);
  });

  it('ignores target-shaped caller fields and always emits the held binding command', async () => {
    let observed: ListeningModeCommand | null = null;
    const service = {
      async read() { return { ok: false as const, code: 'unavailable' as const }; },
      async set(_authority: unknown, _context: unknown, _capabilities: unknown, command: ListeningModeCommand) {
        observed = command;
        return {
          v: 1 as const,
          commandId: command.commandId,
          bindingId: command.bindingId,
          generation: command.expectedBindingGeneration,
          outcome: 'refused' as const,
          version: command.expectedVersion,
          requested: command.requested,
          effective: null,
          reason: 'unavailable',
        };
      },
    };
    const application = createAgentListeningModeAuthority(held(), context(held()), service);

    await application.set({
      ...setInput,
      bindingId: 'other-binding',
      expectedBindingGeneration: 77,
    } as Parameters<typeof application.set>[0]);

    expect(observed).toMatchObject({ bindingId: held().bindingId, expectedBindingGeneration: 3 });
  });
});
