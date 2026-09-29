import { describe, expect, it } from 'vitest';
import { decodeDeliveryLimits, type SessionBinding } from '@khala/contracts/delivery/index';
import { nativeCliCapabilities } from '@khala/harnesses/codex/capabilities';
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
      expect((await harness.inspect(approved)).support).toBe('tested');
      expect(inspected).toEqual([binding.sessionId]);
      expect((await harness.inspect({ ...approved, deviceId: 'wrong_device' as never })).support).not.toBe('tested');
    } finally { await harness.close(); }
  });
  it('drops cached native route capability when the owner or binding is revoked', async () => {
    let current = true;
    const harness = createHostedCodexHarness({ binding,
      claim: { harness: 'codex', sessionId: binding.sessionId, workdir: '/project' },
      sessionInspection: { inspect: async () => ({ kind: 'verified' as const,
        session: { harness: 'codex', sessionId: binding.sessionId, generation: 0 },
        capabilities: nativeCliCapabilities('0.154.0', limits.value) }) },
      current: async () => current, resolveExecutable: async () => null,
      inspectHooks: async () => null,
      openInbox: async () => ({ enqueue: async () => 'appended', notifyListener: async () => 'notified' }),
    });
    try {
      expect((await harness.inspect(binding)).support).toBe('tested');
      current = false;
      expect((await harness.inspect(binding)).support).not.toBe('tested');
      expect(await harness.reconcile({ binding } as never)).toBeNull();
    } finally { await harness.close(); }
  });
});
