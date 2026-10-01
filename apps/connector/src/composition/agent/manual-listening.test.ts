import { describe, expect, it } from 'vitest';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { createManualReadWitness, manualListeningCapabilities, manualReadProof } from './manual-listening';

const binding = { v: 1 as const, bindingId: 'binding_manual' as never,
  ownerId: 'owner_manual' as never, agentParticipantId: 'agent_manual' as never,
  deviceId: 'device_manual' as never, harness: 'proof-key', sessionId: 'agent_manual', generation: 2 };
const ack = { bindingId: binding.bindingId, generation: binding.generation,
  kind: 'agent_acknowledged' as const, source: 'agent' as const };

describe('hosted manual listening capability', () => {
  it.each(['claude', 'codex'] as const)('keeps %s modes unavailable until route and receipt proof exists', harness => {
    const capability = manualListeningCapabilities(binding, harness, 'unknown', null);
    expect(decodeHarnessCapabilities(capability)).toEqual({ ok: true, value: capability });
    expect(capability.acknowledgement).toBe('unknown');
    expect(capability.modes.steer).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('delivery hook') });
    expect(capability.modes.sync).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('delivery hook') });
    expect(capability.modes.async).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('receipt proof') });
  });

  it.each(['claude', 'codex'] as const)('offers only %s explicit-pull Async after an exact agent ACK', harness => {
    const capability = manualListeningCapabilities(binding, harness, '1.2.3', ack);
    expect(decodeHarnessCapabilities(capability)).toEqual({ ok: true, value: capability });
    expect(capability.modes).toMatchObject({ steer: { status: 'unsupported' },
      sync: { status: 'unsupported' }, async: { status: 'proven', testedVersion: '1.2.3' } });
    expect(capability.acknowledgement).toBe('batch_token_next_call');
    expect(manualListeningCapabilities(binding, harness, '1.2.3', { ...ack, generation: 1 }).modes.async.status)
      .toBe('unsupported');
    expect(manualListeningCapabilities(binding, harness, '1.2.3', {
      ...ack, bindingId: 'foreign' as never }).modes.async.status).toBe('unsupported');
  });

  it('rejects a hook ACK after manual restart until a fresh explicit read and token return', async () => {
    const receipt = (bindingId: string, generation: number, releaseId: string) =>
      ({ kind: 'agent_acknowledged', source: 'agent', bindingId, generation, releaseId });
    const rows = [receipt('foreign', 2, 'foreign-release'), receipt(binding.bindingId, 1, 'prior-generation'),
      receipt(binding.bindingId, 2, 'old-hook-release')];
    const recorder = { readAgentAcknowledgement: async (_principal: unknown, releaseId: string) =>
      rows.find(row => row.releaseId === releaseId) ?? null } as never;
    // A new manual connector starts with no route witness even though its old hook ACK remains in the ledger.
    const witness = createManualReadWitness();
    witness.acknowledge(binding.bindingId, 2, 'old-hook-token', ['old-hook-release']);
    expect(await manualReadProof(recorder, binding, witness)).toBeNull();
    witness.offer(binding.bindingId, 1, 'wrong-generation-token');
    await witness.withinExplicitRead(async () => witness.acknowledge(binding.bindingId, 2,
      'wrong-generation-token', ['old-hook-release']));
    expect(await manualReadProof(recorder, binding, witness)).toBeNull();
    witness.offer(binding.bindingId, 2, 'manual-read-token');
    rows.push(receipt(binding.bindingId, 2, 'new-manual-release'));
    witness.acknowledge(binding.bindingId, 2, 'manual-read-token', ['new-manual-release']);
    expect(await manualReadProof(recorder, binding, witness)).toBeNull();
    witness.offer(binding.bindingId, 2, 'manual-read-token');
    await witness.withinExplicitRead(async () => witness.acknowledge(binding.bindingId, 2,
      'manual-read-token', ['new-manual-release']));
    expect(await manualReadProof(recorder, binding, witness)).toEqual(ack);
    expect(await manualReadProof({ readAgentAcknowledgement: async () => receipt('foreign', 2, 'new-manual-release') } as never,
      binding, witness)).toBeNull();
    expect(await manualReadProof({ readAgentAcknowledgement: async () => { throw Error('offline'); } }, binding,
      witness)).toBeNull();
  });
});
