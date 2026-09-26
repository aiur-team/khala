import { describe, expect, it, vi } from 'vitest';
import {
  createAgentListeningModeApplication,
  type AgentListeningModeApplication, type AgentListeningModePort, type AgentListeningModeSetInput,
} from '@khala/connector/agent/listening-mode';
import type {
  AgentBindingAuthority, BindingId, CommandId, ListeningModeCommand, ListeningModeResult, ListeningModeView,
} from '@khala/contracts/delivery/index';
import { EXPECTED_VIEW, MODE_VIEW, fakeModeApplication } from './fixtures/listening-mode.js';
import { ListeningModeOperation, parseSetRequest } from './listening-mode.js';

function operation(application: AgentListeningModeApplication | null) {
  let counter = 0;
  return new ListeningModeOperation({
    application,
    newCommandId: () => `command-${++counter}`,
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  });
}

describe('ListeningModeOperation', () => {
  it('returns the allowlisted exact-binding view with every support reason and no target or grant fields', async () => {
    const application = {
      read: vi.fn(async () => ({ ok: true as const, view: { ...MODE_VIEW, injected: 'do-not-print' } as ListeningModeView })),
      set: vi.fn(),
    };

    const outcome = await operation(application).get();

    expect(outcome).toEqual(EXPECTED_VIEW);
    const text = JSON.stringify(outcome);
    for (const leaked of ['do-not-print', 'binding-1', 'generation', 'Grants', 'authority']) {
      expect(text).not.toContain(leaked);
    }
    expect(application.read).toHaveBeenCalledWith();
  });

  it('submits only requested and expectedVersion with fresh per-call metadata and returns the applied projection', async () => {
    const fake = fakeModeApplication();
    const mode = operation(fake.application);

    await expect(mode.set({ requested: 'async', expectedVersion: 4 })).resolves.toEqual({
      kind: 'applied', requested: 'async', effective: 'async', effectiveReason: null, version: 5,
    });
    await mode.set({ requested: 'sync', expectedVersion: 5 });

    expect(fake.sets).toEqual([
      { commandId: 'command-1', expectedVersion: 4, requested: 'async', issuedAt: '2026-09-25T12:00:00.000Z' },
      { commandId: 'command-2', expectedVersion: 5, requested: 'sync', issuedAt: '2026-09-25T12:00:00.000Z' },
    ]);
  });

  it('reports a stale version as a conflict with the current state, preserving the concurrent winner without retry', async () => {
    const fake = fakeModeApplication();
    const mode = operation(fake.application);
    const seen = await mode.get();
    expect(seen).toMatchObject({ kind: 'view', version: 4 });

    fake.ownerWrite('steer');
    const outcome = await mode.set({ requested: 'async', expectedVersion: 4 });

    expect(outcome).toEqual({
      kind: 'conflict', reason: 'stale_version',
      current: { requested: 'steer', effective: 'steer', effectiveReason: null, version: 5 },
    });
    expect(fake.application.set).toHaveBeenCalledOnce();
    expect(fake.state).toEqual({ requested: 'steer', version: 5 });
  });

  it('maps every refusal to a stable reason that never claims the requested mode took effect', async () => {
    for (const code of ['forbidden', 'binding_mismatch', 'stale_binding', 'binding_revoked', 'unavailable'] as const) {
      const application = { read: vi.fn(async () => ({ ok: false as const, code })), set: vi.fn() };
      await expect(operation(application).get()).resolves.toEqual({ kind: 'refused', reason: code });
    }
    for (const reason of ['binding_mismatch', 'stale_binding', 'binding_revoked', 'idempotency_conflict', 'unavailable', 'surprise']) {
      const application = {
        read: vi.fn(),
        set: vi.fn(async (input: AgentListeningModeSetInput): Promise<ListeningModeResult> => ({
          v: 1, commandId: input.commandId, bindingId: 'binding-1' as BindingId, generation: 3, outcome: 'refused',
          version: 4, requested: input.requested, effective: null, reason,
        })),
      };
      const outcome = await operation(application).set({ requested: 'async', expectedVersion: 4 });
      expect(outcome).toEqual({ kind: 'refused', reason: reason === 'surprise' ? 'unavailable' : reason });
      expect(JSON.stringify(outcome)).not.toContain('async');
    }
  });

  it('fails closed without a composed application and reports thrown or mismatched writes as outcome_unknown', async () => {
    await expect(operation(null).get()).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
    await expect(operation(null).set({ requested: 'sync', expectedVersion: 0 }))
      .resolves.toEqual({ kind: 'refused', reason: 'unavailable' });

    const throwing = { read: vi.fn(async () => { throw new Error('boom'); }), set: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(operation(throwing).get()).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
    await expect(operation(throwing).set({ requested: 'sync', expectedVersion: 0 }))
      .resolves.toEqual({ kind: 'refused', reason: 'outcome_unknown' });

    const foreign = {
      read: vi.fn(),
      set: vi.fn(async (input: AgentListeningModeSetInput): Promise<ListeningModeResult> => ({
        v: 1, commandId: 'someone-else' as CommandId, bindingId: 'binding-1' as BindingId, generation: 3,
        outcome: 'applied', version: 5, requested: input.requested, effective: input.requested, reason: null,
      })),
    };
    await expect(operation(foreign).set({ requested: 'sync', expectedVersion: 4 }))
      .resolves.toEqual({ kind: 'refused', reason: 'outcome_unknown' });
  });

  it('composes with the trusted connector application so only captured authority reaches the port', async () => {
    let currentGeneration = 3;
    const commands: ListeningModeCommand[] = [];
    const port = {
      read: vi.fn<AgentListeningModePort['read']>(async authority => authority.generation === currentGeneration
        ? { ok: true, view: MODE_VIEW }
        : { ok: false, code: 'stale_binding' }),
      set: vi.fn<AgentListeningModePort['set']>(async (authority, command) => {
        commands.push(command);
        const refused = authority.generation !== currentGeneration || command.expectedBindingGeneration !== currentGeneration;
        return {
          v: 1, commandId: command.commandId, bindingId: command.bindingId, generation: authority.generation,
          outcome: refused ? 'refused' : 'applied', version: refused ? 4 : 5, requested: command.requested,
          effective: refused ? null : command.requested, reason: refused ? 'stale_binding' : null,
        };
      }),
    };
    const authority = { kind: 'agent_binding', bindingId: 'binding-1', generation: 3 } as unknown as AgentBindingAuthority;
    const application = createAgentListeningModeApplication(authority, port);
    const mode = operation(application);

    await expect(mode.set({ requested: 'async', expectedVersion: 4 })).resolves.toMatchObject({ kind: 'applied', version: 5 });
    expect(commands).toEqual([{
      v: 1, commandId: 'command-1', bindingId: 'binding-1', expectedBindingGeneration: 3, expectedVersion: 4,
      requested: 'async', issuedAt: '2026-09-25T12:00:00.000Z',
    }]);
    expect(port.set.mock.calls[0]?.[0]).toBe(authority);

    currentGeneration = 4;
    await expect(mode.get()).resolves.toEqual({ kind: 'refused', reason: 'stale_binding' });
    await expect(mode.set({ requested: 'sync', expectedVersion: 5 })).resolves.toEqual({ kind: 'refused', reason: 'stale_binding' });
    expect(Object.keys(application).sort()).toEqual(['read', 'set']);
  });

  it('fails closed on malformed port views and on commandId-matched but invalid or unknown set results', async () => {
    for (const view of [
      { ...MODE_VIEW, requested: 'fast' },
      { ...MODE_VIEW, version: -1 },
      { ...MODE_VIEW, support: { steer: MODE_VIEW.support.steer, sync: MODE_VIEW.support.sync } },
      { ...MODE_VIEW, support: { ...MODE_VIEW.support, async: { ...MODE_VIEW.support.async, status: 'guessed' } } },
      { ...MODE_VIEW, support: { ...MODE_VIEW.support, sync: { ...MODE_VIEW.support.sync, evidenceRef: 7 } } },
    ]) {
      const application = { read: vi.fn(async () => ({ ok: true as const, view: view as unknown as ListeningModeView })), set: vi.fn() };
      await expect(operation(application).get()).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
    }

    for (const overrides of [{ requested: 'fast' }, { outcome: 'mystery' }, { version: 1.5 }]) {
      const application = {
        read: vi.fn(),
        set: vi.fn(async (input: AgentListeningModeSetInput) => ({
          v: 1, commandId: input.commandId, bindingId: 'binding-1', generation: 3, outcome: 'applied', version: 5,
          requested: input.requested, effective: input.requested, reason: null, ...overrides,
        }) as unknown as ListeningModeResult),
      };
      await expect(operation(application).set({ requested: 'sync', expectedVersion: 4 }))
        .resolves.toEqual({ kind: 'refused', reason: 'outcome_unknown' });
    }
  });

  it('rejects partial, extra, target-, generation-, authority-, and grant-shaped input before the application', async () => {
    const fake = fakeModeApplication();
    const mode = operation(fake.application);
    for (const input of [
      null, [], {}, { requested: 'sync' }, { expectedVersion: 4 },
      { requested: 'fast', expectedVersion: 4 }, { requested: 'sync', expectedVersion: -1 },
      { requested: 'sync', expectedVersion: 1.5 }, { requested: 'sync', expectedVersion: '4' },
      { requested: 'sync', expectedVersion: 4, bindingId: 'binding-2' },
      { requested: 'sync', expectedVersion: 4, expectedBindingGeneration: 2 },
      { requested: 'sync', expectedVersion: 4, authority: { kind: 'agent_binding' } },
      { requested: 'sync', expectedVersion: 4, kind: 'grant_hard_cancel' },
      { requested: 'sync', expectedVersion: 4, commandId: 'chosen' },
    ]) {
      expect(() => parseSetRequest(input)).toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
      await expect(mode.set(input)).rejects.toMatchObject({ code: 'invalid_arguments' });
    }
    expect(fake.application.set).not.toHaveBeenCalled();
  });
});
