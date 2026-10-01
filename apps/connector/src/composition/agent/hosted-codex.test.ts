import { describe, expect, it } from 'vitest';
import { decodeDeliveryLimits, type SessionBinding } from '@khala/contracts/delivery/index';
import { nativeCliCapabilities } from '@khala/harnesses/codex/capabilities';
import { routeSnapshot, supportedRoute } from '@khala/connector/dispatch/budget';
import { createHostedCodexHarness } from './hosted-codex';

const binding: SessionBinding = { v: 1, bindingId: 'binding_hosted_codex' as never,
  ownerId: 'owner_hosted_codex' as never, agentParticipantId: 'agent_hosted_codex' as never,
  deviceId: 'device_hosted_codex' as never, harness: 'codex', sessionId: 'thread_hosted_codex', generation: 0 };
const limits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!limits.ok) throw new Error('limits');

describe('hosted Codex harness authority', () => {
  it('projects an approved proof-key binding only to the exact native thread', async () => {
    const approved = { ...binding, harness: 'proof-key', sessionId: 'agent_approved_key' };
    const inspected: string[] = [];
    const harness = createHostedCodexHarness({ binding: approved,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async claim => { inspected.push(claim.sessionId); return {
        kind: 'verified' as const,
        session: { harness: 'codex', sessionId: binding.sessionId, generation: 0 },
        capabilities: nativeCliCapabilities('0.154.0', limits.value),
      }; } },
      current: async () => true, resolveExecutable: async () => null,
      inspectHooks: async () => null,
      openInbox: async () => ({ enqueue: async () => 'appended', notifyListener: async () => 'notified' }),
    });
    try {
      const queueOnly = await harness.inspect(approved);
      expect(queueOnly.support).toBe('tested');
      expect(queueOnly.harness).toBe('proof-key');
      expect(routeSnapshot(queueOnly, approved, 'sync', 'hook-revision')).toBeNull();
      expect(inspected).toEqual([binding.sessionId]);
      expect((await harness.inspect({ ...approved, deviceId: 'wrong_device' as never })).support).not.toBe('tested');
    } finally { await harness.close(); }
  });
  it('admits only a proved route for the exact approved proof-key binding', async () => {
    const approved = { ...binding, harness: 'proof-key', sessionId: 'agent_approved_key' };
    const events: string[] = [];
    const capabilities = nativeCliCapabilities('0.159.3', limits.value);
    const proof = { status: 'proven' as const, route: 'codex-hook', testedVersion: '0.159.3',
      evidenceRef: 'hook-proof', evidenceRevision: 'hook-revision', reason: null };
    const harness = createHostedCodexHarness({ binding: approved,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async () => ({ kind: 'verified' as const,
        session: { harness: 'codex', sessionId: binding.sessionId, generation: 0 }, capabilities }) },
      current: async () => true, resolveExecutable: async () => null,
      inspectHooks: async () => ({ ...capabilities, modes: { ...capabilities.modes, sync: proof } }),
      diagnostic: event => events.push(event.result),
      openInbox: async () => ({ enqueue: async () => 'appended', notifyListener: async () => 'notified' }),
    });
    try {
      const inspected = await harness.inspect(approved);
      expect(inspected).toMatchObject({ harness: 'proof-key', support: 'tested', version: '0.159.3' });
      expect(supportedRoute({ ...inspected, harness: 'codex' }, approved)).toBe(false);
      expect(supportedRoute(inspected, approved)).toBe(true);
      expect(routeSnapshot(inspected, approved, 'sync', 'hook-revision')).toMatchObject({
        bindingGeneration: 0, sessionId: approved.sessionId, harness: 'proof-key', route: 'codex-hook' });
      expect(routeSnapshot(inspected, approved, 'sync', 'stale-revision')).toBeNull();
      expect(events).toContain('route_tested');
    } finally { await harness.close(); }
  });
  it.each(['0.159.2', '0.160.0'])('withholds unsupported native version %s and a changed generation', async version => {
    const approved = { ...binding, harness: 'proof-key', sessionId: 'agent_approved_key' };
    const events: string[] = [];
    const unsupported = nativeCliCapabilities(version, limits.value);
    const harness = createHostedCodexHarness({ binding: approved,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async () => ({ kind: 'verified' as const,
        session: { harness: 'codex', sessionId: binding.sessionId, generation: 0 },
        capabilities: unsupported }) },
      current: async () => true, resolveExecutable: async () => null,
      inspectHooks: async () => null, diagnostic: event => events.push(event.result),
      openInbox: async () => ({ enqueue: async () => 'appended', notifyListener: async () => 'notified' }),
    });
    try {
      expect((await harness.inspect(approved)).support).toBe('unsupported');
      expect((await harness.inspect({ ...approved, generation: 1 })).support).toBe('unsupported');
      expect(events).toEqual(['native_version_unsupported', 'binding_mismatch']);
    } finally { await harness.close(); }
  });
  it('does not promote 0.160.0 from a hook claim without a native queue contract', async () => {
    const approved = { ...binding, harness: 'proof-key', sessionId: 'agent_approved_key' };
    const native = nativeCliCapabilities('0.160.0', limits.value);
    let hookInspections = 0;
    let enqueues = 0;
    const harness = createHostedCodexHarness({ binding: approved,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async () => ({ kind: 'verified' as const,
        session: { harness: 'codex', sessionId: binding.sessionId, generation: 0 }, capabilities: native }) },
      current: async () => true, resolveExecutable: async () => null,
      inspectHooks: async () => { hookInspections += 1; return { ...native, support: 'tested' }; },
      openInbox: async () => ({ enqueue: async () => { enqueues += 1; return 'appended'; },
        notifyListener: async () => 'notified' }),
    });
    try {
      const result = await harness.inspect(approved);
      expect(result.support).toBe('unsupported');
      expect(result.acknowledgement).toBe('unknown');
      expect(routeSnapshot(result, approved, 'sync', 'hook-revision')).toBeNull();
      expect(hookInspections).toBe(0);
      expect(enqueues).toBe(0);
    } finally { await harness.close(); }
  });
  it('reports a transient current-session inspection failure without granting a route', async () => {
    const diagnostics: string[] = [];
    const harness = createHostedCodexHarness({ binding,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async () => { throw new Error('must not inspect'); } },
      current: async () => { throw new Error('temporary storage failure'); },
      resolveExecutable: async () => null, inspectHooks: async () => null,
      diagnostic: event => diagnostics.push(event.result),
      openInbox: async () => ({ enqueue: async () => 'appended', notifyListener: async () => 'notified' }),
    });
    try {
      expect((await harness.inspect(binding)).support).toBe('unsupported');
      expect(diagnostics).toEqual(['current_unavailable']);
    } finally { await harness.close(); }
  });
  it('reports a foreign native session without admitting or enqueuing', async () => {
    const diagnostics: string[] = [];
    let enqueued = 0;
    const harness = createHostedCodexHarness({ binding,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async () => ({ kind: 'verified' as const,
        session: { harness: 'codex', sessionId: 'foreign-thread', generation: 0 },
        capabilities: nativeCliCapabilities('0.159.3', limits.value) }) },
      current: async () => true, resolveExecutable: async () => null,
      inspectHooks: async () => null, diagnostic: event => diagnostics.push(event.result),
      openInbox: async () => ({ enqueue: async () => { enqueued += 1; return 'appended'; },
        notifyListener: async () => 'notified' }),
    });
    try {
      expect((await harness.inspect(binding)).support).toBe('unsupported');
      expect(diagnostics).toEqual(['native_session_mismatch', 'native_unsupported']);
      expect(enqueued).toBe(0);
    } finally { await harness.close(); }
  });
  it('drops cached native route capability when the owner or binding is revoked', async () => {
    let current = true;
    const diagnostics: string[] = [];
    const harness = createHostedCodexHarness({ binding,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async () => ({ kind: 'verified' as const,
        session: { harness: 'codex', sessionId: binding.sessionId, generation: 0 },
        capabilities: nativeCliCapabilities('0.154.0', limits.value) }) },
      current: async () => current, resolveExecutable: async () => null,
      diagnostic: event => diagnostics.push(event.result),
      inspectHooks: async () => null,
      openInbox: async () => ({ enqueue: async () => 'appended', notifyListener: async () => 'notified' }),
    });
    try {
      expect((await harness.inspect(binding)).support).toBe('tested');
      current = false;
      expect((await harness.inspect(binding)).support).not.toBe('tested');
      expect(diagnostics).toContain('current_unavailable');
      expect(await harness.reconcile({ binding } as never)).toBeNull();
    } finally { await harness.close(); }
  });
});
