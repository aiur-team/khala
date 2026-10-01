import { describe, expect, it } from 'vitest';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { manualListeningCapabilities, manualReadProof } from './manual-listening';

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

  it('finds only an authenticated ACK for this binding and generation', async () => {
    const receipt = (bindingId: string, generation: number) => ({
      receipt: { kind: 'agent_acknowledged', source: 'agent', bindingId, generation },
    });
    const recorder = { readReceiptOutbox: async () => [receipt('foreign', 2), receipt(binding.bindingId, 1),
      receipt(binding.bindingId, 2)] } as never;
    expect(await manualReadProof(recorder, binding)).toEqual(ack);
    expect(await manualReadProof({ readReceiptOutbox: async () => [receipt('foreign', 2)] } as never, binding)).toBeNull();
    expect(await manualReadProof({ readReceiptOutbox: async () => { throw Error('offline'); } }, binding)).toBeNull();
  });
});
