import type { SessionBinding } from '@khala/contracts/delivery/index';
import {
  CONNECTOR_CAPABILITY_IDS,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
  type ConnectorCapabilityId,
  type RuntimeDispatcherPort,
  type RuntimeLedgerPort,
  validateCapabilityRegistry,
} from './capabilities';
import {
  copyStatus,
  initialPrerequisites,
  type PrerequisiteState,
  type RuntimePrerequisite,
  type RuntimeStatus,
} from './status';

export type { RuntimeDispatcherPort } from './capabilities';

export interface RuntimeStoragePort extends RuntimeLedgerPort {
  close(): Promise<void>;
}

export interface RuntimeDevicePort {
  readonly fingerprint: string;
  close(): Promise<void>;
}

export interface RuntimeSubscriptionPort {
  state(): Exclude<PrerequisiteState, 'unsupported'>;
  onStateChange(listener: (state: Exclude<PrerequisiteState, 'unsupported'>) => void): () => void;
  stop(): Promise<void>;
}

export interface RuntimeHarnessPort {
  inspect(): Promise<Readonly<{ state: 'ready' | 'unsupported' | 'unknown' }>>;
  close(): Promise<void>;
}

export type EffectiveControls = Readonly<{
  state: 'ready' | 'blocked' | 'unknown';
  version: number | null;
}>;

export type BootstrapResult = Readonly<{ binding: SessionBinding }>;

export type ConnectorRuntimeConfig = Readonly<{
  requiredCapabilities: readonly ConnectorCapabilityId[];
  clock?: () => number;
}>;

export interface ConnectorRuntimeFactories {
  openStorage(): Promise<RuntimeStoragePort>;
  openDevice(storage: RuntimeStoragePort): Promise<RuntimeDevicePort>;
  bindDeviceIdentity(storage: RuntimeStoragePort, device: RuntimeDevicePort): Promise<void>;
  bootstrap(input: Readonly<{ storage: RuntimeStoragePort; device: RuntimeDevicePort }>): Promise<BootstrapResult>;
  openSubscription(input: Readonly<{
    storage: RuntimeStoragePort;
    device: RuntimeDevicePort;
    binding: SessionBinding;
  }>): Promise<RuntimeSubscriptionPort>;
  loadControls(input: Readonly<{ storage: RuntimeStoragePort; binding: SessionBinding }>): Promise<EffectiveControls>;
  openHarness(binding: SessionBinding): Promise<RuntimeHarnessPort>;
  openDispatcher(input: Readonly<{
    storage: RuntimeStoragePort;
    binding: SessionBinding;
    harness: RuntimeHarnessPort;
  }>): Promise<RuntimeDispatcherPort>;
  registerCapabilities(context: ConnectorCapabilityContext): readonly ConnectorCapability[];
}

export interface ConnectorRuntime {
  start(): Promise<void>;
  status(): RuntimeStatus;
  stop(): Promise<void>;
}

export class RuntimePrerequisiteError extends Error {
  constructor(
    readonly prerequisite: RuntimePrerequisite,
    readonly state: PrerequisiteState,
    readonly code: string,
  ) {
    super(code);
    this.name = 'RuntimePrerequisiteError';
  }
}

function assertConfig(config: ConnectorRuntimeConfig): void {
  const seen = new Set<ConnectorCapabilityId>();
  for (const id of config.requiredCapabilities) {
    if (!CONNECTOR_CAPABILITY_IDS.includes(id)) throw new Error(`unknown required capability: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate required capability: ${id}`);
    seen.add(id);
  }
}

function readinessErrorCode(
  subscription: ReturnType<RuntimeSubscriptionPort['state']>,
  controls: EffectiveControls | undefined,
  harness: 'ready' | 'unsupported' | 'unknown',
  unavailableCapability: ConnectorCapabilityId | undefined,
): string | null {
  if (subscription !== 'ready') return `subscription_${subscription}`;
  if (controls?.state !== 'ready') return `controls_${controls?.state ?? 'unknown'}`;
  if (harness !== 'ready') return `harness_${harness}`;
  if (unavailableCapability) return `capability_${unavailableCapability}_unavailable`;
  return null;
}

export function createConnectorRuntime(
  config: ConnectorRuntimeConfig,
  factories: ConnectorRuntimeFactories,
): ConnectorRuntime {
  let current: RuntimeStatus = copyStatus({
    binding: null,
    phase: 'stopped',
    prerequisites: initialPrerequisites(),
    effectivePolicyVersion: null,
    errorCode: null,
  });
  let storage: RuntimeStoragePort | undefined;
  let device: RuntimeDevicePort | undefined;
  let subscription: RuntimeSubscriptionPort | undefined;
  let unsubscribe: (() => void) | undefined;
  let harness: RuntimeHarnessPort | undefined;
  let dispatcher: RuntimeDispatcherPort | undefined;
  let capabilities: readonly ConnectorCapability[] = [];
  const startedCapabilities = new Set<ConnectorCapability>();
  let controls: EffectiveControls | undefined;
  let harnessState: 'ready' | 'unsupported' | 'unknown' = 'unknown';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let transition = Promise.resolve();
  let stopRequested = false;
  let terminalTeardownFailure: Readonly<{ error: unknown }> | undefined;

  const update = (changes: Partial<RuntimeStatus>, prerequisites?: Partial<RuntimeStatus['prerequisites']>) => {
    current = copyStatus({
      ...current,
      ...changes,
      prerequisites: { ...current.prerequisites, ...prerequisites },
    });
  };

  const reevaluate = async (): Promise<void> => {
    if (!subscription || current.phase === 'stopping' || current.phase === 'stopped') return;
    const subscriptionState = subscription.state();
    const capabilityState = new Map(capabilities.map(capability => [capability.id, capability.state]));
    const requiredCapabilityIds = [
      'controls' as const,
      ...config.requiredCapabilities.filter(id => id !== 'controls'),
    ];
    const unavailableCapabilityId = requiredCapabilityIds.find(id => capabilityState.get(id) !== 'ready');
    const errorCode = readinessErrorCode(subscriptionState, controls, harnessState, unavailableCapabilityId);
    const ready = errorCode === null;
    dispatcher?.setEnabled(ready);
    const capabilityPrerequisites: Partial<Record<RuntimePrerequisite, PrerequisiteState>> = {};
    for (const id of ['review', 'recovery'] as const) {
      capabilityPrerequisites[id] = capabilityState.get(id) === 'ready' ? 'ready' : 'blocked';
    }
    const controlsPrerequisite = capabilityState.get('controls') === 'ready'
      ? controls?.state ?? 'blocked'
      : 'blocked';
    update(
      {
        phase: ready ? 'ready' : 'degraded',
        errorCode,
      },
      {
        subscription: subscriptionState,
        controls: controlsPrerequisite,
        dispatch: ready ? 'ready' : 'blocked',
        ...capabilityPrerequisites,
      },
    );
  };

  const enqueueTransition = (task: () => Promise<void>): Promise<void> => {
    const pending = transition.then(task, task);
    transition = pending.catch(() => undefined);
    return pending;
  };

  const recordReadinessFailure = (error: unknown): void => {
    if (current.phase === 'stopping' || current.phase === 'stopped') return;
    dispatcher?.setEnabled(false);
    if (error instanceof RuntimePrerequisiteError) {
      update(
        { phase: 'degraded', errorCode: error.code },
        { [error.prerequisite]: error.state, dispatch: 'blocked' },
      );
      return;
    }
    update({ phase: 'degraded', errorCode: 'readiness_failed' }, { dispatch: 'blocked' });
  };

  const scheduleReadinessBarrier = (): void => {
    dispatcher?.setEnabled(false);
    update({}, { dispatch: 'blocked' });
    void enqueueTransition(runReadinessBarrier).catch(recordReadinessFailure);
  };

  const teardown = async (): Promise<void> => {
    const errors: unknown[] = [];
    const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    const activeDispatcher = dispatcher;
    dispatcher = undefined;
    await attempt(() => activeDispatcher?.setEnabled(false));
    const activeCapabilities = [...capabilities].reverse();
    capabilities = [];
    startedCapabilities.clear();
    for (const capability of activeCapabilities) await attempt(() => capability.stop());
    if (activeDispatcher) await attempt(() => activeDispatcher.stop());
    const activeHarness = harness;
    harness = undefined;
    if (activeHarness) await attempt(() => activeHarness.close());
    const activeUnsubscribe = unsubscribe;
    unsubscribe = undefined;
    if (activeUnsubscribe) await attempt(activeUnsubscribe);
    const activeSubscription = subscription;
    subscription = undefined;
    if (activeSubscription) await attempt(() => activeSubscription.stop());
    const activeDevice = device;
    device = undefined;
    if (activeDevice) await attempt(() => activeDevice.close());
    const activeStorage = storage;
    storage = undefined;
    if (activeStorage) await attempt(() => activeStorage.close());
    controls = undefined;
    harnessState = 'unknown';
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'connector runtime teardown failed');
  };

  const runReadinessBarrier = async (): Promise<void> => {
    const activeStorage = storage;
    const activeSubscription = subscription;
    const activeBinding = current.binding;
    if (
      !activeStorage
      || !activeSubscription
      || !activeBinding
      || current.phase === 'stopping'
      || current.phase === 'stopped'
      || stopRequested
    ) return;

    dispatcher?.setEnabled(false);
    update({}, { dispatch: 'blocked' });
    if (activeSubscription.state() !== 'ready') {
      await reevaluate();
      return;
    }

    controls = await factories.loadControls({ storage: activeStorage, binding: activeBinding });
    if (stopRequested) return;
    update({ effectivePolicyVersion: controls.version }, { controls: controls.state });
    if (activeSubscription.state() !== 'ready' || controls.state !== 'ready') {
      await reevaluate();
      return;
    }

    if (!harness) harness = await factories.openHarness(activeBinding);
    if (stopRequested) return;
    harnessState = (await harness.inspect()).state;
    if (stopRequested) return;
    update({}, { harness: harnessState });
    if (activeSubscription.state() !== 'ready' || harnessState !== 'ready') {
      await reevaluate();
      return;
    }

    if (!dispatcher) {
      dispatcher = await factories.openDispatcher({ storage: activeStorage, binding: activeBinding, harness });
    }
    if (stopRequested) return;
    dispatcher.setEnabled(false);
    await dispatcher.reconcilePending();
    if (stopRequested) return;
    if (activeSubscription.state() !== 'ready') {
      await reevaluate();
      return;
    }

    if (capabilities.length === 0) {
      capabilities = validateCapabilityRegistry(factories.registerCapabilities({
        binding: activeBinding,
        ledger: activeStorage,
        dispatcher,
        clock: config.clock ?? Date.now,
        prerequisiteChanged: () => {
          scheduleReadinessBarrier();
        },
      }));
    }
    for (const capability of capabilities) {
      if (startedCapabilities.has(capability)) continue;
      await capability.start();
      startedCapabilities.add(capability);
      if (stopRequested) return;
    }
    await reevaluate();
  };

  const runStart = async (): Promise<void> => {
    assertConfig(config);
    update({
      binding: null,
      phase: 'starting',
      prerequisites: initialPrerequisites(),
      effectivePolicyVersion: null,
      errorCode: null,
    });
    try {
      storage = await factories.openStorage();
      if (stopRequested) return;
      update({}, { storage: 'ready' });
      device = await factories.openDevice(storage);
      if (stopRequested) return;
      await factories.bindDeviceIdentity(storage, device);
      if (stopRequested) return;
      update({}, { device: 'ready' });
      const bootstrap = await factories.bootstrap({ storage, device });
      if (stopRequested) return;
      update({ binding: bootstrap.binding }, { bootstrap: 'ready' });
      subscription = await factories.openSubscription({ storage, device, binding: bootstrap.binding });
      if (stopRequested) return;
      update({}, { subscription: subscription.state() });
      unsubscribe = subscription.onStateChange(state => {
        update({}, { subscription: state });
        scheduleReadinessBarrier();
      });
      if (subscription.state() !== 'ready') {
        update({ phase: 'degraded', errorCode: `subscription_${subscription.state()}` });
        return;
      }
      await enqueueTransition(runReadinessBarrier);
    } catch (error) {
      if (error instanceof RuntimePrerequisiteError) {
        update({ phase: 'degraded', errorCode: error.code }, { [error.prerequisite]: error.state });
        return;
      }
      update({ phase: 'stopping' });
      try {
        await teardown();
      } catch (teardownError) {
        terminalTeardownFailure = { error: teardownError };
        throw teardownError;
      } finally {
        update({ phase: 'stopped', errorCode: terminalTeardownFailure ? 'teardown_failed' : null });
      }
      throw error;
    }
  };

  const start = (): Promise<void> => {
    if (terminalTeardownFailure) return Promise.reject(terminalTeardownFailure.error);
    if (stopPromise) {
      const activeStop = stopPromise;
      return activeStop.then(start);
    }
    if (current.phase === 'ready' || current.phase === 'degraded') return Promise.resolve();
    if (!startPromise) {
      stopRequested = false;
      const pending = runStart().finally(() => {
        if (startPromise === pending) startPromise = undefined;
      });
      startPromise = pending;
    }
    return startPromise;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    if (current.phase === 'stopped' && !startPromise) {
      return terminalTeardownFailure === undefined
        ? Promise.resolve()
        : Promise.reject(terminalTeardownFailure.error);
    }
    stopRequested = true;
    update({ phase: 'stopping' });
    const pending = (async () => {
      if (startPromise) await startPromise.catch(() => undefined);
      await transition;
      try {
        await teardown();
      } catch (error) {
        terminalTeardownFailure = { error };
        throw error;
      } finally {
        update(
          {
            phase: 'stopped',
            binding: null,
            effectivePolicyVersion: null,
            errorCode: terminalTeardownFailure ? 'teardown_failed' : null,
          },
          initialPrerequisites(),
        );
      }
    })().finally(() => {
      if (stopPromise === pending) stopPromise = undefined;
    });
    stopPromise = pending;
    return stopPromise;
  };

  return {
    start,
    status() {
      return current;
    },
    stop,
  };
}
