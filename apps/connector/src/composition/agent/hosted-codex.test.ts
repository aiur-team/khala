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
