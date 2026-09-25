import type {
  AgentBindingAuthority,
  BindingId,
  CommandId,
  ListeningModeCommand,
  ListeningModeResult,
} from '@khala/contracts/delivery/index';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createAgentListeningModeApplication,
  type AgentListeningModeApplication,
  type AgentListeningModePort,
} from './listening-mode';

const authority = {
  kind: 'agent_binding',
  bindingId: 'binding-held' as BindingId,
  generation: 4,
} as AgentBindingAuthority;

const applied: ListeningModeResult = {
  v: 1,
  commandId: 'set-mode' as CommandId,
  bindingId: authority.bindingId,
  generation: 4,
  outcome: 'applied',
  version: 3,
  requested: 'steer',
  effective: 'steer',
  reason: null,
};

describe('agent listening-mode application', () => {
  it('binds reads and sets to the injected authority with no caller target', async () => {
    const read = vi.fn<AgentListeningModePort['read']>(async () => ({ ok: false, code: 'unavailable' }));
    const set = vi.fn<AgentListeningModePort['set']>(async () => applied);
    const application = createAgentListeningModeApplication(authority, { read, set });

    await application.read();
    await application.set({
      commandId: 'set-mode' as CommandId,
      expectedVersion: 2,
      requested: 'steer',
      issuedAt: '2026-09-24T12:00:00Z',
      bindingId: 'attacker-target',
      expectedBindingGeneration: 99,
    } as Parameters<AgentListeningModeApplication['set']>[0]);

    expect(read).toHaveBeenCalledWith(authority);
    expect(set).toHaveBeenCalledWith(authority, {
      v: 1,
      commandId: 'set-mode' as CommandId,
      bindingId: authority.bindingId,
      expectedBindingGeneration: authority.generation,
      expectedVersion: 2,
      requested: 'steer',
      issuedAt: '2026-09-24T12:00:00Z',
    } satisfies ListeningModeCommand);
  });

  it('exposes no owner grant or revoke methods', () => {
    const application = createAgentListeningModeApplication(authority, {
      read: async () => ({ ok: false, code: 'unavailable' }),
      set: async () => applied,
    });

    expect(Object.keys(application).sort()).toEqual(['read', 'set']);
    expect(application).not.toHaveProperty('grantExperimentalRoute');
    expect(application).not.toHaveProperty('revokeExperimentalRoute');
    expect(application).not.toHaveProperty('grantHardCancel');
    expect(application).not.toHaveProperty('revokeHardCancel');
    expectTypeOf(createAgentListeningModeApplication).parameter(0).toEqualTypeOf<AgentBindingAuthority>();
  });
});
