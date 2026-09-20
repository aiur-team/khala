import {
  decodeDeliveryLimits,
  type HarnessCapabilities,
  type HarnessPort,
  type SessionBinding,
} from '@khala/contracts/delivery/index';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHarnessSelection, type HarnessSelectionStore } from './harnesses';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: 65_536 });
if (!decodedLimits.ok) throw new Error('invalid limits');
const limits = decodedLimits.value;

const binding = {
  v: 1,
  bindingId: 'binding-native-1',
  ownerId: 'owner-native-1',
  agentParticipantId: 'agent-native-1',
  deviceId: 'device-native-1',
  harness: 'codex',
  sessionId: 'session-native-1',
  generation: 0,
} as SessionBinding;

function capabilities(input: Partial<HarnessCapabilities> = {}): HarnessCapabilities {
  return {
    v: 2,
    harness: 'codex',
    version: '0.154.0',
    adapterVersion: 'native-cli-notification-1',
    support: 'tested',
    existingSession: 'native_cli_queue',
    immediateNotification: 'native_cli_queue',
    busy: 'queue',
    receiptEvidence: ['harness_queued', 'outcome_unknown', 'failed'],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: 'docs/evidence/codex-native-cli.md#queue-idle',
    ...input,
  };
}

function harness(report: HarnessCapabilities): HarnessPort & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined);
  return {
    inspect: vi.fn(async () => report),
    async notify() {},
    async submit() { throw new Error('not used'); },
    async reconcile() { return null; },
    close,
  };
}

function store(result: Awaited<ReturnType<HarnessSelectionStore['record']>> = 'stored'): HarnessSelectionStore {
  return { record: vi.fn(async () => result) };
}

describe('runtime harness selection', () => {
  it('selects and records the first evidence-backed native route', async () => {
    const selected = harness(capabilities());
    const selections = store();
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'codex-native', harness: selected },
    ], selections);

    await expect(runtime.inspect()).resolves.toMatchObject({
      state: 'ready',
      routeId: 'codex-native',
      capabilities: { existingSession: 'native_cli_queue' },
    });
    expect(runtime.selected()).toBe(selected);
    expect(selections.record).toHaveBeenCalledWith({
      bindingId: binding.bindingId,
      generation: 0,
      routeId: 'codex-native',
    });
  });

  it('falls back to an experimental agent-installed listener when native routes are unusable', async () => {
    const unsupported = harness(capabilities({
      support: 'unsupported',
      existingSession: 'unsupported',
      immediateNotification: 'unsupported',
    }));
    const fallback = harness(capabilities({
      version: 'skill-1',
      adapterVersion: 'agent-listener-1',
      support: 'experimental',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      busy: 'unknown',
      receiptEvidence: [],
      evidenceRef: null,
    }));
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'codex-native', harness: unsupported },
      { routeId: 'khala-skill', harness: fallback, fallback: true },
    ], store(), { allowExperimentalAgentListener: true });

    await expect(runtime.inspect()).resolves.toMatchObject({
      state: 'ready',
      routeId: 'khala-skill',
      capabilities: { existingSession: 'agent_installed_listener', support: 'experimental' },
    });
    expect(runtime.selected()).toBe(fallback);
  });

  it('does not inspect or select the experimental fallback without operator opt-in', async () => {
    const fallback = harness(capabilities({
      version: 'skill-1',
      adapterVersion: 'agent-listener-1',
      support: 'experimental',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      busy: 'unknown',
      receiptEvidence: [],
      evidenceRef: null,
    }));
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'khala-skill', harness: fallback, fallback: true },
    ], store());

    await expect(runtime.inspect()).resolves.toEqual({
      state: 'unsupported',
      capabilities: null,
      routeId: null,
    });
    expect(fallback.inspect).not.toHaveBeenCalled();
    expect(runtime.selected()).toBeNull();
  });

  it('prefers a tested native route without inspecting or recording a usable fallback', async () => {
    const native = harness(capabilities());
    const fallback = harness(capabilities({
      version: 'skill-1',
      adapterVersion: 'agent-listener-1',
      support: 'experimental',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      busy: 'unknown',
      receiptEvidence: [],
      evidenceRef: null,
    }));
    const selections = store();
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'khala-skill', harness: fallback, fallback: true },
      { routeId: 'codex-native', harness: native },
    ], selections);

    await expect(runtime.inspect()).resolves.toMatchObject({ state: 'ready', routeId: 'codex-native' });
    expect(runtime.selected()).toBe(native);
    expect(native.inspect).toHaveBeenCalledOnce();
    expect(fallback.inspect).not.toHaveBeenCalled();
    expect(selections.record).toHaveBeenCalledOnce();
    expect(selections.record).toHaveBeenCalledWith({
      bindingId: binding.bindingId,
      generation: binding.generation,
      routeId: 'codex-native',
    });
  });

  it('refuses a route change within one binding generation', async () => {
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'codex-native', harness: harness(capabilities()) },
    ], store('route_changed'));

    await expect(runtime.inspect()).resolves.toMatchObject({
      state: 'unknown',
      reason: 'route_changed',
      routeId: 'codex-native',
    });
    expect(runtime.selected()).toBeNull();
  });

  it('refuses a stale binding generation', async () => {
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'codex-native', harness: harness(capabilities()) },
    ], store('stale_generation'));

    await expect(runtime.inspect()).resolves.toMatchObject({
      state: 'unknown',
      reason: 'stale_generation',
      routeId: 'codex-native',
    });
    expect(runtime.selected()).toBeNull();
  });

  it('fails closed when route selection cannot be persisted', async () => {
    const selectionStore: HarnessSelectionStore = {
      record: vi.fn(async () => { throw new Error('ledger offline'); }),
    };
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'codex-native', harness: harness(capabilities()) },
    ], selectionStore);

    await expect(runtime.inspect()).resolves.toMatchObject({
      state: 'unknown',
      reason: 'selection_unavailable',
      routeId: 'codex-native',
    });
    expect(runtime.selected()).toBeNull();
  });

  it('continues to the fallback when native inspection fails', async () => {
    const broken = harness(capabilities());
    vi.mocked(broken.inspect).mockRejectedValueOnce(new Error('inspect failed'));
    const fallback = harness(capabilities({
      support: 'experimental',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      evidenceRef: null,
    }));
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'codex-native', harness: broken },
      { routeId: 'khala-skill', harness: fallback, fallback: true },
    ], store(), { allowExperimentalAgentListener: true });

    await expect(runtime.inspect()).resolves.toMatchObject({ state: 'ready', routeId: 'khala-skill' });
    expect(runtime.selected()).toBe(fallback);
  });

  it('closes every candidate once without inspecting a route after close', async () => {
    const first = harness(capabilities());
    const fallback = harness(capabilities({
      support: 'experimental',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      evidenceRef: null,
    }));
    const runtime = createRuntimeHarnessSelection(binding, [
      { routeId: 'codex-native', harness: first },
      { routeId: 'khala-skill', harness: fallback, fallback: true },
    ], store());

    await runtime.close();
    await runtime.close();
    await expect(runtime.inspect()).resolves.toMatchObject({ state: 'unknown', reason: 'closed' });
    expect(first.close).toHaveBeenCalledOnce();
    expect(fallback.close).toHaveBeenCalledOnce();
  });
});
