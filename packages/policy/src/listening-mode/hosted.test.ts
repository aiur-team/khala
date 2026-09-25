import type {
  AgentBindingAuthority,
  BindingId,
  CommandId,
  DeliveryLimits,
  HarnessCapabilities,
  ListeningModeCommand,
} from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { listeningModeStoreConformance } from '../../test/fixtures/listening-mode/conformance';
import { authority, binding, command as policyCommand, owner, start } from '../../test/trust/fakes';
import { evaluatePolicyChange } from '../trust/transitions';
import type { TrustState } from '../trust/types';
import {
  createHostedListeningModeStore,
  type HostedTrustStatePort,
  type HostedTrustStateSnapshot,
} from './hosted';
import {
  createListeningModeService,
  type ListeningModeStoreWrite,
} from './store';

const support = (status: 'proven' | 'experimental' | 'unsupported', route: string) => status === 'unsupported'
  ? {
      status,
      route,
      testedVersion: '1.0.0',
      evidenceRef: 'docs/evidence/harness.md',
      evidenceRevision: 'harness-v1',
      reason: 'Route is unavailable.',
    } as const
  : {
      status,
      route,
      testedVersion: '1.0.0',
      evidenceRef: 'docs/evidence/harness.md',
      evidenceRevision: 'harness-v1',
      reason: status === 'experimental' ? 'Owner consent required.' : null,
    } as const;

const capabilities = (steer: 'proven' | 'experimental' | 'unsupported' = 'proven'): HarnessCapabilities => ({
  v: 3,
  harness: 'claude',
  version: '1.0.0',
  adapterVersion: 'hooks-1',
  support: 'tested',
  existingSession: 'agent_installed_listener',
  immediateNotification: 'agent_installed_listener',
  busy: 'queue',
  receiptEvidence: ['harness_queued'],
  reconcileByReleaseId: 'unsupported',
  limits: { maxSelectionEvents: 32, maxPayloadBytes: 65_536 } as DeliveryLimits,
  evidenceRef: 'docs/evidence/harness.md',
  modes: {
    steer: support(steer, 'claude-hook-steer'),
    sync: support('proven', 'claude-hook-sync'),
    async: support('proven', 'khala-read'),
  },
  acknowledgement: 'batch_token_next_call',
});

const agent = (generation = 1): AgentBindingAuthority => ({
  kind: 'agent_binding', bindingId: binding().bindingId, generation,
} as AgentBindingAuthority);

const modeCommand = (
  commandId: string,
  requested: ListeningModeCommand['requested'],
  expectedVersion = 1,
): ListeningModeCommand => ({
  v: 1,
  commandId: commandId as CommandId,
  bindingId: binding().bindingId,
  expectedBindingGeneration: 1,
  expectedVersion,
  requested,
  issuedAt: '2026-09-24T12:00:00Z',
});

const storeWrite = (
  state: TrustState,
  operationId = 'hosted-write',
): ListeningModeStoreWrite => ({
  key: { bindingId: state.bindingId, generation: state.generation },
  expectedVersion: state.listeningMode.version,
  operationId,
  operationFingerprint: JSON.stringify([operationId, 'steer']),
  next: {
    requested: 'steer',
    experimentalGrants: state.listeningMode.experimentalGrants,
    hardCancelGrants: state.listeningMode.hardCancelGrants,
  },
});

class MemoryTrustStateHost implements HostedTrustStatePort {
  #revision = 1;
  #state: TrustState;
  #barrierRemaining = 0;
  #releaseBarrier: (() => void) | null = null;
  #barrier: Promise<void> | null = null;
  beforeFirstCompare: ((state: TrustState) => TrustState) | null = null;

  constructor(state = start()) {
    this.#state = state;
  }

  synchronizeNext(count: number): void {
    this.#barrierRemaining = count;
    this.#barrier = new Promise(resolve => { this.#releaseBarrier = resolve; });
  }

  state(): TrustState {
    return this.#state;
  }

  async read(): Promise<Readonly<{ kind: 'record'; snapshot: HostedTrustStateSnapshot }>> {
    return { kind: 'record', snapshot: { revision: String(this.#revision), state: this.#state } };
  }

  async compareAndSet(expectedRevision: string, state: TrustState) {
    if (this.#barrierRemaining > 0 && this.#barrier) {
      this.#barrierRemaining -= 1;
      if (this.#barrierRemaining === 0) this.#releaseBarrier?.();
      await this.#barrier;
    }
    if (this.beforeFirstCompare) {
      const transition = this.beforeFirstCompare;
      this.beforeFirstCompare = null;
      this.#state = transition(this.#state);
      this.#revision += 1;
    }
    if (expectedRevision !== String(this.#revision)) return { kind: 'conflict' as const };
    this.#state = state;
    this.#revision += 1;
    return { kind: 'applied' as const, revision: String(this.#revision) };
  }
}

listeningModeStoreConformance('hosted', () => {
  const host = new MemoryTrustStateHost(start());
  const initial = host.state().listeningMode;
  return {
    store: createHostedListeningModeStore(host),
    key: { bindingId: initial.bindingId, generation: initial.generation },
    initial,
  };
});

describe('hosted listening-mode store', () => {
  it('reconstructs durable control and recomputes effective mode from current capabilities', async () => {
    const host = new MemoryTrustStateHost(start());
    const first = createListeningModeService(createHostedListeningModeStore(host));
    const context = { binding: binding(), status: 'active' as const };

    await expect(first.set(agent(), context, capabilities('experimental'), modeCommand('set-steer', 'steer')))
      .resolves.toMatchObject({ outcome: 'applied', version: 2, requested: 'steer', effective: null });
    await expect(first.grantExperimentalRoute(authority(), context, capabilities('experimental'), {
      v: 1,
      kind: 'grant_experimental_route',
      commandId: 'grant-steer' as CommandId,
      bindingId: binding().bindingId,
      expectedBindingGeneration: 1,
      expectedVersion: 2,
      mode: 'steer',
      route: 'claude-hook-steer',
      harnessVersion: '1.0.0',
      evidenceRevision: 'harness-v1',
      issuedAt: '2026-09-24T12:00:00Z',
    })).resolves.toMatchObject({ outcome: 'applied', view: { version: 3, effective: 'steer' } });

    const restarted = createListeningModeService(createHostedListeningModeStore(host));
    await expect(restarted.read(agent(), context, capabilities('unsupported'))).resolves.toMatchObject({
      ok: true,
      view: {
        requested: 'steer',
        version: 3,
        effective: null,
        effectiveReason: 'support_unsupported',
        experimentalGrants: [{ kind: 'experimental_route' }],
      },
    });
  });

  it('allows exactly one of two synchronized writes at the same expected version', async () => {
    const host = new MemoryTrustStateHost(start());
    host.synchronizeNext(2);
    const service = createListeningModeService(createHostedListeningModeStore(host));
    const context = { binding: binding(), status: 'active' as const };

    const results = await Promise.all([
      service.set(agent(), context, capabilities(), modeCommand('race-steer', 'steer')),
      service.set(agent(), context, capabilities(), modeCommand('race-async', 'async')),
    ]);

    expect(results.map(result => result.outcome).sort()).toEqual(['applied', 'conflict']);
    expect(host.state().listeningMode.version).toBe(2);
  });

  it('retries an aggregate conflict without discarding a concurrent policy transition', async () => {
    const host = new MemoryTrustStateHost(start());
    host.beforeFirstCompare = state => evaluatePolicyChange(
      state,
      owner(),
      policyCommand({ mode: 'review', paused: true }),
      'active',
    ).state;
    const service = createListeningModeService(createHostedListeningModeStore(host));

    await expect(service.set(
      agent(),
      { binding: binding(), status: 'active' },
      capabilities(),
      modeCommand('set-steer', 'steer'),
    )).resolves.toMatchObject({ outcome: 'applied', requested: 'steer' });

    expect(host.state().requested).toMatchObject({ version: 2, mode: 'review', paused: true });
    expect(host.state().listeningMode).toMatchObject({ version: 2, requested: 'steer' });
  });

  it('isolates records by binding and generation', async () => {
    const store = createHostedListeningModeStore(new MemoryTrustStateHost(start()));

    await expect(store.read({ bindingId: 'other' as BindingId, generation: 1 }))
      .resolves.toEqual({ kind: 'absent' });
    await expect(store.read({ bindingId: binding().bindingId, generation: 2 }))
      .resolves.toEqual({ kind: 'absent' });
  });

  it('returns unavailable when the host aggregate cannot be read', async () => {
    const state = start();
    const host: HostedTrustStatePort = {
      async read() { return { kind: 'unavailable' }; },
      async compareAndSet() { throw new Error('compareAndSet must not be called'); },
    };
    const store = createHostedListeningModeStore(host);

    await expect(store.read({ bindingId: state.bindingId, generation: state.generation }))
      .resolves.toEqual({ kind: 'unavailable' });
    await expect(store.compareAndSet(storeWrite(state)))
      .resolves.toEqual({ kind: 'unavailable' });
  });

  it('returns unavailable without mutation when the host CAS is unavailable', async () => {
    const state = start();
    const initialControl = state.listeningMode;
    let compares = 0;
    const host: HostedTrustStatePort = {
      async read() {
        return { kind: 'record', snapshot: { revision: '1', state } };
      },
      async compareAndSet() {
        compares += 1;
        return { kind: 'unavailable' };
      },
    };

    await expect(createHostedListeningModeStore(host).compareAndSet(storeWrite(state)))
      .resolves.toEqual({ kind: 'unavailable' });
    expect(compares).toBe(1);
    expect(state.listeningMode).toBe(initialControl);
    expect(state.listeningModeJournal.size).toBe(0);
  });

  it('returns unavailable after sixteen aggregate conflicts without mutating the host state', async () => {
    const state = start();
    const initialControl = state.listeningMode;
    let compares = 0;
    const host: HostedTrustStatePort = {
      async read() {
        return { kind: 'record', snapshot: { revision: '1', state } };
      },
      async compareAndSet() {
        compares += 1;
        return { kind: 'conflict' };
      },
    };

    await expect(createHostedListeningModeStore(host).compareAndSet(storeWrite(state)))
      .resolves.toEqual({ kind: 'unavailable' });
    expect(compares).toBe(16);
    expect(state.listeningMode).toBe(initialControl);
    expect(state.listeningModeJournal.size).toBe(0);
  });
});
