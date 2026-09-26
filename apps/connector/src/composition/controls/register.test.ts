import type { BindingId, RoomId, SessionBinding } from '@khala/contracts/delivery/index';
import type { ConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { describe, expect, it } from 'vitest';
import type { ConnectorCapabilityContext } from '../../runtime/capabilities';
import type { PolicyControlHandler, TrustStateStore } from './control-handler';
import { type ControlsProtectedTransportPort, registerControls } from './register';

const context = {
  binding: { bindingId: 'binding_b' as BindingId } as SessionBinding,
  ledger: { runtimeLedgerPort: true },
  dispatcher: { reconcilePending: async () => undefined, setEnabled: () => undefined, stop: async () => undefined },
  clock: () => 0,
  prerequisiteChanged: () => undefined,
} satisfies ConnectorCapabilityContext;

// Ledger reads fail on this stand-in; reconciliation reports nothing and serving continues.
const control = {
  dispatchStorage: {} as Pick<ConnectorDispatchStorage, 'ledger' | 'applyEffectivePolicy'>,
  trust: {} as TrustStateStore,
  roomId: 'room_controls' as RoomId,
};

function transport() {
  const served: PolicyControlHandler[] = [];
  let disposed = 0;
  const port: ControlsProtectedTransportPort = {
    capability: 'controls',
    serve(handler) {
      served.push(handler);
      return () => { disposed += 1; };
    },
  };
  return { port, served, disposed: () => disposed };
}

describe('connector controls registration', () => {
  it('stays unavailable without the protected transport or its control dependencies', () => {
    expect(registerControls({ ...context, dependencies: {} }).state).toBe('unavailable');
    expect(registerControls({ ...context, dependencies: { control } }).state).toBe('unavailable');
    expect(registerControls({ ...context, dependencies: { protectedTransport: transport().port } }).state)
      .toBe('unavailable');
    const wrongChannel = { ...transport().port, capability: 'review' } as unknown as ControlsProtectedTransportPort;
    expect(registerControls({ ...context, dependencies: { protectedTransport: wrongChannel, control } }).state)
      .toBe('unavailable');
  });

  it('serves the handler only on the protected transport, once, until stopped', async () => {
    const { port, served, disposed } = transport();
    const capability = registerControls({ ...context, dependencies: { protectedTransport: port, control } });

    expect(capability.state).toBe('ready');
    // The handle exposes no policy entry point a model tool could be handed.
    expect(Object.keys(capability).sort()).toEqual(['id', 'start', 'state', 'stop']);

    await Promise.all([capability.start(), capability.start()]);
    await capability.start();
    expect(served).toHaveLength(1);
    expect(Object.keys(served[0]!).sort()).toEqual(['reconcile', 'setPolicy', 'status']);

    await capability.stop();
    await capability.stop();
    expect(disposed()).toBe(1);
  });

  it('keeps the transport closed when stopped during reconciliation', async () => {
    const interrupted = transport();
    const capability = registerControls({ ...context, dependencies: { protectedTransport: interrupted.port, control } });
    const starting = capability.start();
    await capability.stop();
    await starting;
    expect(interrupted.served).toEqual([]);
  });
});
