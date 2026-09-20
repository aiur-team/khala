import {
  decodeDeliveryLimits,
  type HarnessCapabilities,
  type HarnessPort,
  type SessionBinding,
} from '@khala/contracts/delivery/index';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHarnessAdapter } from './harness';

const binding = {
  v: 1,
  bindingId: 'binding-runtime-1',
  ownerId: 'owner-runtime-1',
  agentParticipantId: 'agent-runtime-1',
  deviceId: 'device-runtime-1',
  harness: 'codex',
  sessionId: 'existing-session-1',
  generation: 0,
} as SessionBinding;

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('invalid test limits');

const admitted: HarnessCapabilities = {
  v: 2,
  harness: 'codex',
  version: '0.154.0',
  adapterVersion: 'hosted-resume',
  support: 'tested',
  existingSession: 'khala_hosted_resume',
  immediateNotification: 'khala_hosted_idle',
  busy: 'queue',
  receiptEvidence: ['harness_queued', 'outcome_unknown', 'failed'],
  reconcileByReleaseId: 'while_queued',
  limits: decodedLimits.value,
  evidenceRef: 'docs/evidence/codex.md',
};

function realHarness(report: unknown): HarnessPort & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined);
  return {
    inspect: vi.fn(async () => report as HarnessCapabilities),
    async notify() {},
    async submit() { throw new Error('not used'); },
    async reconcile() { return null; },
    close,
  };
}

describe('runtime harness adapter', () => {
  it('reports ready only for the tested admitted existing-session route', async () => {
    const harness = realHarness(admitted);
    const adapter = createRuntimeHarnessAdapter(binding, harness);

    await expect(adapter.inspect()).resolves.toMatchObject({ state: 'ready' });
    expect(harness.inspect).toHaveBeenCalledWith(binding);

    await adapter.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('does not admit an experimental hosted-resume route', async () => {
    const adapter = createRuntimeHarnessAdapter(binding, realHarness({
      ...admitted,
      support: 'experimental',
    }));

    await expect(adapter.inspect()).resolves.toMatchObject({ state: 'unknown' });
  });

  it('admits tested native CLI queue support', async () => {
    const adapter = createRuntimeHarnessAdapter(binding, realHarness({
      ...admitted,
      adapterVersion: 'native-cli-notification',
      existingSession: 'native_cli_queue',
      immediateNotification: 'native_cli_queue',
      reconcileByReleaseId: 'unsupported',
      evidenceRef: 'docs/evidence/codex-native-cli.md',
    }));

    await expect(adapter.inspect()).resolves.toMatchObject({
      state: 'ready',
      capabilities: {
        support: 'tested',
        existingSession: 'native_cli_queue',
      },
    });
  });

  it('reports an explicitly unsupported route as unsupported', async () => {
    const adapter = createRuntimeHarnessAdapter(binding, realHarness({
      ...admitted,
      support: 'unsupported',
      existingSession: 'unsupported',
      immediateNotification: 'unsupported',
      busy: 'unknown',
      receiptEvidence: [],
      reconcileByReleaseId: 'unsupported',
    }));

    await expect(adapter.inspect()).resolves.toMatchObject({ state: 'unsupported' });
  });

  it('maps malformed capability reports to unknown', async () => {
    const adapter = createRuntimeHarnessAdapter(binding, realHarness({
      support: 'tested',
      existingSession: 'khala_hosted_resume',
      pendingPlaintext: 'must not escape through status',
    }));

    await expect(adapter.inspect()).resolves.toMatchObject({ state: 'unknown' });
  });
});
