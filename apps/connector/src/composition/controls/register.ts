import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';
import {
  createPolicyControlHandler,
  type PolicyControlDependencies,
  type PolicyControlHandler,
} from './control-handler';

/**
 * The protected human control transport selected by KHA-144/133. It authenticates
 * the human, derives `OwnerAuthority` from that session and only then calls the
 * handler. A generic chat message, MCP tool call or model notification is never
 * this transport, so no model-facing surface can change trust or pause.
 */
export interface ControlsProtectedTransportPort {
  readonly capability: 'controls';
  /** Serves `handler` to authenticated human callers until the returned disposer runs. */
  serve(handler: PolicyControlHandler): () => void;
}

export type ControlsCapabilityDependencies = Readonly<{
  protectedTransport?: ControlsProtectedTransportPort;
  /** Dispatch ledger, durable trust state and the served room for the handler. */
  control?: Omit<PolicyControlDependencies, 'bindingId'>;
}>;

export type ControlsCapabilityContext = ConnectorCapabilityContext & Readonly<{
  dependencies: ControlsCapabilityDependencies;
}>;

/**
 * Replaces the KHA-133 placeholder in place. Without a protected transport and its
 * control dependencies, including a durable trust store, the capability stays
 * `unavailable`: no substitute channel is opened and controls readiness is never claimed.
 */
export function registerControls(context: ControlsCapabilityContext): ConnectorCapability {
  const { protectedTransport, control } = context.dependencies;
  if (!protectedTransport || protectedTransport.capability !== 'controls' || !control) {
    return unavailableCapability('controls');
  }
  const bindingId = context.binding.bindingId;
  const handler = createPolicyControlHandler({ ...control, bindingId });
  let dispose: (() => void) | null = null;
  let starting: Promise<void> | null = null;
  // Each stop invalidates every start still waiting on reconciliation.
  let epoch = 0;

  return Object.freeze({
    id: 'controls' as const,
    state: 'ready' as const,
    start() {
      if (dispose !== null) return Promise.resolve();
      if (starting !== null) return starting;
      const token = epoch;
      const run = async (): Promise<void> => {
        try {
          // A request accepted before a crash is enforced before new commands are served. If that
          // fails now, every command still enforces it first, so serving stays safe.
          await handler.reconcile(bindingId).catch(() => undefined);
          if (token === epoch && dispose === null) dispose = protectedTransport.serve(handler);
        } finally {
          if (starting === current) starting = null;
        }
      };
      const current = run();
      starting = current;
      return current;
    },
    async stop() {
      epoch += 1;
      starting = null;
      const active = dispose;
      dispose = null;
      active?.();
    },
  });
}
