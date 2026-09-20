import type { SessionBinding } from '@khala/contracts/delivery/index';
import { describe, expect, it, vi } from 'vitest';
import {
  RuntimePrerequisiteError,
  createConnectorRuntime,
  type ConnectorRuntimeFactories,
  type RuntimeDispatcherPort,
} from './create';
import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityId,
} from './capabilities';

const binding = {
  v: 1,
  bindingId: 'binding-1',
  ownerId: 'owner-1',
  agentParticipantId: 'agent-1',
  deviceId: 'device-1',
  harness: 'claude',
  sessionId: 'session-1',
  generation: 0,
} as SessionBinding;

function readyCapability(
  id: ConnectorCapabilityId,
  events?: string[],
): ConnectorCapability {
  return {
    id,
    state: 'ready',
    start: async () => { events?.push(`${id}.start`); },
    stop: async () => { events?.push(`${id}.stop`); },
  };
}

function recordingFactories(events: string[], harnessState: 'ready' | 'unsupported' = 'ready'):
ConnectorRuntimeFactories {
  const dispatcher: RuntimeDispatcherPort = {
    reconcilePending: async () => { events.push('dispatch.reconcile'); },
    setEnabled(value) { events.push(`dispatch.enabled:${value}`); },
    stop: async () => { events.push('dispatch.stop'); },
  };
  return {
    openStorage: async () => ({
      close: async () => { events.push('storage.close'); },
    }),
    openDevice: async () => ({
      fingerprint: 'fingerprint-1',
      close: async () => { events.push('device.close'); },
    }),
    bindDeviceIdentity: async () => { events.push('device.bind'); },
    bootstrap: async () => { events.push('bootstrap'); return { binding }; },
    openSubscription: async () => ({
      state: () => 'ready',
      onStateChange: () => () => undefined,
      stop: async () => { events.push('subscription.stop'); },
    }),
    loadControls: async () => { events.push('controls.load'); return { state: 'ready', version: 7 }; },
    openHarness: async () => ({
      inspect: async () => { events.push('harness.inspect'); return { state: harnessState }; },
      close: async () => { events.push('harness.close'); },
    }),
    openDispatcher: async () => dispatcher,
    registerCapabilities: () => [
      unavailableCapability('review'),
      readyCapability('controls', events),
      unavailableCapability('recovery'),
    ],
  };
}

describe('createConnectorRuntime', () => {
  it('does no work until one coalesced start runs the ordered barriers', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);

    expect(events).toEqual([]);
    await Promise.all([runtime.start(), runtime.start()]);

    expect(events).toEqual([
      'device.bind',
      'bootstrap',
      'controls.load',
      'harness.inspect',
      'dispatch.enabled:false',
      'dispatch.reconcile',
      'controls.start',
      'dispatch.enabled:true',
    ]);
    expect(runtime.status()).toMatchObject({
      binding,
      phase: 'ready',
      effectivePolicyVersion: 7,
      errorCode: null,
      prerequisites: {
        storage: 'ready',
        device: 'ready',
        bootstrap: 'ready',
        subscription: 'ready',
        controls: 'ready',
        harness: 'ready',
        dispatch: 'ready',
      },
    });
  });

  it('keeps unsupported harness composition degraded and never enables dispatch', async () => {
    const events: string[] = [];
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, recordingFactories(events, 'unsupported'));

    await runtime.start();

    expect(runtime.status()).toMatchObject({
      phase: 'degraded',
      errorCode: 'harness_unsupported',
      prerequisites: { harness: 'unsupported', dispatch: 'blocked' },
    });
    expect(events).not.toContain('dispatch.enabled:true');
  });

  it('maps classified prerequisite failures to content-free degraded status', async () => {
    const factories = recordingFactories([]);
    factories.openStorage = async () => {
      throw new RuntimePrerequisiteError('storage', 'offline', 'storage_unavailable');
    };
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);

    await expect(runtime.start()).resolves.toBeUndefined();

    expect(runtime.status()).toMatchObject({
      binding: null,
      phase: 'degraded',
      errorCode: 'storage_unavailable',
      prerequisites: { storage: 'offline' },
    });
  });

  it('stops opened resources in reverse order and repeated stop is safe', async () => {
    const events: string[] = [];
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, recordingFactories(events));
    await runtime.start();
    events.length = 0;

    await Promise.all([runtime.stop(), runtime.stop()]);

    expect(events).toEqual([
      'dispatch.enabled:false',
      'controls.stop',
      'dispatch.stop',
      'harness.close',
      'subscription.stop',
      'device.close',
      'storage.close',
    ]);
    expect(runtime.status().phase).toBe('stopped');
  });

  it('revokes dispatch eligibility when subscription readiness is lost', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    let state: 'ready' | 'offline' = 'ready';
    let notify: ((next: 'ready' | 'offline') => void) | undefined;
    factories.openSubscription = async () => ({
      state: () => state,
      onStateChange(listener) { notify = listener; return () => undefined; },
      stop: async () => undefined,
    });
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
    await runtime.start();
    events.length = 0;

    state = 'offline';
    notify?.(state);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('degraded'));

    expect(events).toContain('dispatch.enabled:false');
    expect(runtime.status()).toMatchObject({
      errorCode: 'subscription_offline',
      prerequisites: { subscription: 'offline', dispatch: 'blocked' },
    });
  });

  it('completes deferred barriers when an initially offline subscription recovers', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    let state: 'ready' | 'offline' = 'offline';
    let notify: ((next: 'ready' | 'offline') => void) | undefined;
    factories.openSubscription = async () => ({
      state: () => state,
      onStateChange(listener) { notify = listener; return () => undefined; },
      stop: async () => undefined,
    });
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);

    await runtime.start();
    expect(runtime.status()).toMatchObject({ phase: 'degraded', errorCode: 'subscription_offline' });
    expect(events).not.toContain('controls.load');

    state = 'ready';
    notify?.(state);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'));

    expect(events.indexOf('controls.load')).toBeLessThan(events.indexOf('dispatch.reconcile'));
    expect(events.indexOf('dispatch.reconcile')).toBeLessThan(events.indexOf('dispatch.enabled:true'));
  });

  it('reruns controls and reconciliation before re-enabling after a disconnect', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    let state: 'ready' | 'offline' = 'ready';
    let notify: ((next: 'ready' | 'offline') => void) | undefined;
    factories.openSubscription = async () => ({
      state: () => state,
      onStateChange(listener) { notify = listener; return () => undefined; },
      stop: async () => undefined,
    });
    factories.registerCapabilities = () => [
      readyCapability('review', events),
      readyCapability('controls', events),
      readyCapability('recovery', events),
    ];
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
    await runtime.start();
    expect(events.filter(event => event.endsWith('.start'))).toEqual([
      'review.start',
      'controls.start',
      'recovery.start',
    ]);
    events.length = 0;

    state = 'offline';
    notify?.(state);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('degraded'));
    state = 'ready';
    notify?.(state);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'));

    expect(events).toContain('dispatch.enabled:false');
    expect(events.indexOf('controls.load')).toBeLessThan(events.indexOf('dispatch.reconcile'));
    expect(events.indexOf('dispatch.reconcile')).toBeLessThan(events.lastIndexOf('dispatch.enabled:true'));
    expect(events.filter(event => event.endsWith('.start'))).toEqual([]);
  });

  it('reports a classified reconnect failure and keeps dispatch blocked', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    let state: 'ready' | 'offline' = 'ready';
    let notify: ((next: 'ready' | 'offline') => void) | undefined;
    let controlsLoads = 0;
    factories.openSubscription = async () => ({
      state: () => state,
      onStateChange(listener) { notify = listener; return () => undefined; },
      stop: async () => undefined,
    });
    factories.loadControls = async () => {
      controlsLoads += 1;
      if (controlsLoads > 1) throw new RuntimePrerequisiteError('controls', 'offline', 'controls_unavailable');
      return { state: 'ready', version: 7 };
    };
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
    await runtime.start();

    state = 'offline';
    notify?.(state);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('degraded'));
    state = 'ready';
    notify?.(state);
    await vi.waitFor(() => expect(runtime.status().errorCode).toBe('controls_unavailable'));

    expect(runtime.status()).toMatchObject({
      phase: 'degraded',
      prerequisites: { controls: 'offline', dispatch: 'blocked' },
    });
    expect(events.at(-1)).toBe('dispatch.enabled:false');
  });

  it('requires the controls capability even when it is not configured explicitly', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    factories.registerCapabilities = () => [
      unavailableCapability('review'),
      unavailableCapability('controls'),
      unavailableCapability('recovery'),
    ];
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);

    await runtime.start();

    expect(runtime.status()).toMatchObject({
      phase: 'degraded',
      errorCode: 'capability_controls_unavailable',
      prerequisites: { controls: 'blocked', dispatch: 'blocked' },
    });
    expect(events).not.toContain('dispatch.enabled:true');
  });

  it('reevaluates a required review capability after its readiness notification', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    let reviewState: 'unavailable' | 'ready' = 'unavailable';
    let prerequisiteChanged: ((id: ConnectorCapabilityId) => void) | undefined;
    factories.registerCapabilities = context => {
      prerequisiteChanged = context.prerequisiteChanged;
      return [
        {
          id: 'review',
          get state() { return reviewState; },
          async start() {},
          async stop() {},
        },
        readyCapability('controls'),
        unavailableCapability('recovery'),
      ];
    };
    const runtime = createConnectorRuntime({ requiredCapabilities: ['review'] }, factories);

    await runtime.start();
    expect(runtime.status()).toMatchObject({
      phase: 'degraded',
      errorCode: 'capability_review_unavailable',
      prerequisites: { review: 'blocked', dispatch: 'blocked' },
    });

    reviewState = 'ready';
    prerequisiteChanged?.('review');
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'));

    expect(runtime.status()).toMatchObject({
      errorCode: null,
      prerequisites: { review: 'ready', dispatch: 'ready' },
    });
    expect(events).toContain('dispatch.enabled:true');
  });

  it('attempts every reverse-order cleanup when an earlier close fails', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    factories.registerCapabilities = () => [
      readyCapability('review', events),
      readyCapability('controls', events),
      {
        ...readyCapability('recovery', events),
        async stop() { events.push('recovery.stop'); throw new Error('recovery close failed'); },
      },
    ];
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
    await runtime.start();
    events.length = 0;

    await expect(runtime.stop()).rejects.toThrow('recovery close failed');

    expect(events).toEqual([
      'dispatch.enabled:false',
      'recovery.stop',
      'controls.stop',
      'review.stop',
      'dispatch.stop',
      'harness.close',
      'subscription.stop',
      'device.close',
      'storage.close',
    ]);
    expect(runtime.status().phase).toBe('stopped');
    expect(runtime.status().errorCode).toBe('teardown_failed');
    await expect(runtime.start()).rejects.toThrow('recovery close failed');
    expect(events.filter(event => event === 'device.bind')).toHaveLength(0);
  });

  it('waits for an in-flight stop before coalescing a fresh start', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    let releaseClose: (() => void) | undefined;
    let openOwners = 0;
    let maximumOpenOwners = 0;
    let storageOpen = 0;
    factories.openStorage = async () => {
      const instance = ++storageOpen;
      openOwners += 1;
      maximumOpenOwners = Math.max(maximumOpenOwners, openOwners);
      return {
        close: async () => {
          if (instance === 1) await new Promise<void>(resolve => { releaseClose = resolve; });
          openOwners -= 1;
        },
      };
    };
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
    await runtime.start();

    const stopping = runtime.stop();
    await vi.waitFor(() => expect(releaseClose).toBeTypeOf('function'));
    const restarting = Promise.all([runtime.start(), runtime.start()]);
    expect(storageOpen).toBe(1);

    releaseClose?.();
    await Promise.all([stopping, restarting]);

    expect(storageOpen).toBe(2);
    expect(maximumOpenOwners).toBe(1);
    expect(runtime.status().phase).toBe('ready');
  });

  it('stop during startup prevents dispatch from ever becoming eligible', async () => {
    const events: string[] = [];
    const factories = recordingFactories(events);
    let finishSubscription: (() => void) | undefined;
    factories.openSubscription = async () => {
      await new Promise<void>(resolve => { finishSubscription = resolve; });
      return {
        state: () => 'ready',
        onStateChange: () => () => undefined,
        stop: async () => { events.push('subscription.stop'); },
      };
    };
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
    const starting = runtime.start();
    await vi.waitFor(() => expect(finishSubscription).toBeTypeOf('function'));

    const stopping = runtime.stop();
    finishSubscription?.();
    await Promise.all([starting, stopping]);

    expect(events).not.toContain('dispatch.enabled:true');
    expect(runtime.status().phase).toBe('stopped');
  });

  it('rejects malformed configuration without opening a factory', async () => {
    const openStorage = vi.fn(recordingFactories([]).openStorage);
    const runtime = createConnectorRuntime(
      { requiredCapabilities: ['controls', 'controls'] },
      { ...recordingFactories([]), openStorage },
    );

    await expect(runtime.start()).rejects.toThrow(/duplicate required capability/);
    expect(openStorage).not.toHaveBeenCalled();
  });
});
