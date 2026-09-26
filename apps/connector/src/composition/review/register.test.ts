import type { BindingId, DeliveryLimits, SessionBinding } from '@khala/contracts/delivery/index';
import type { ConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import type { ConnectorStorage } from '@khala/connector/storage/open';
import { describe, expect, it } from 'vitest';
import type { ConnectorCapabilityContext } from '../../runtime/capabilities';
import type { ReviewControlHandler } from './control-handler';
import { registerReview, type ReviewProtectedTransportPort } from './register';

const context = {
  binding: { bindingId: 'binding_b' as BindingId } as SessionBinding,
  ledger: { runtimeLedgerPort: true },
  dispatcher: { reconcilePending: async () => undefined, setEnabled: () => undefined, stop: async () => undefined },
  clock: () => 0,
  prerequisiteChanged: () => undefined,
} satisfies ConnectorCapabilityContext;

// Recovery reads fail closed on this stand-in; the handler reports that and keeps serving.
const control = {
  storage: {} as ConnectorStorage,
  dispatchStorage: {} as Pick<ConnectorDispatchStorage, 'ledger'>,
  releases: { enqueue: async () => 'queued' as const },
  room: { members: async () => [] },
  limits: {} as DeliveryLimits,
};

function transport() {
  const served: ReviewControlHandler[] = [];
  let disposed = 0;
  const port: ReviewProtectedTransportPort = {
    capability: 'review',
    serve(handler) {
      served.push(handler);
      return () => { disposed += 1; };
    },
  };
  return { port, served, disposed: () => disposed };
}

describe('connector review registration', () => {
  it('stays unavailable without the protected transport or its control dependencies', () => {
    expect(registerReview({ ...context, dependencies: {} }).state).toBe('unavailable');
    expect(registerReview({ ...context, dependencies: { control } }).state).toBe('unavailable');
    expect(registerReview({ ...context, dependencies: { protectedTransport: transport().port } }).state)
      .toBe('unavailable');
    const wrongChannel = { ...transport().port, capability: 'controls' } as unknown as ReviewProtectedTransportPort;
    expect(registerReview({ ...context, dependencies: { protectedTransport: wrongChannel, control } }).state)
      .toBe('unavailable');
  });

  it('serves the handler only on the protected transport, once, until stopped', async () => {
    const { port, served, disposed } = transport();
    const errors: string[] = [];
    const capability = registerReview({
      ...context,
      dependencies: { protectedTransport: port, control: { ...control, onError: code => errors.push(code) } },
    });

    expect(capability.state).toBe('ready');
    // The handle itself exposes no approval entry point a model tool could be handed.
    expect(Object.keys(capability).sort()).toEqual(['id', 'start', 'state', 'stop']);

    await capability.start();
    await capability.start();
    expect(served).toHaveLength(1);
    expect(Object.keys(served[0]!).sort()).toEqual(['approve', 'preview', 'resumeReleases']);
    expect(errors).toEqual(['resume_failed']);

    await capability.stop();
    await capability.stop();
    expect(disposed()).toBe(1);
  });
});
