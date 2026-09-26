import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';
import {
  createReviewControlHandler,
  type ReviewControlDependencies,
  type ReviewControlHandler,
} from './control-handler';

/**
 * The protected human control transport selected by KHA-144/133. It authenticates
 * the human, derives `OwnerAuthority` from that session and only then calls the
 * handler. A generic chat message, MCP tool call or model notification is never
 * this transport.
 */
export interface ReviewProtectedTransportPort {
  readonly capability: 'review';
  /** Serves `handler` to authenticated human callers until the returned disposer runs. */
  serve(handler: ReviewControlHandler): () => void;
}

export type ReviewCapabilityDependencies = Readonly<{
  protectedTransport?: ReviewProtectedTransportPort;
  /** Durable ledger, dispatcher intake and trusted room membership for the handler. */
  control?: ReviewControlDependencies;
}>;

export type ReviewCapabilityContext = ConnectorCapabilityContext & Readonly<{
  dependencies: ReviewCapabilityDependencies;
}>;

/**
 * Replaces the KHA-133 placeholder in place. Without a protected transport and
 * its control dependencies the capability stays `unavailable`: no substitute
 * channel is opened and review readiness is never claimed.
 */
export function registerReview(context: ReviewCapabilityContext): ConnectorCapability {
  const { protectedTransport, control } = context.dependencies;
  if (!protectedTransport || protectedTransport.capability !== 'review' || !control) {
    return unavailableCapability('review');
  }
  const handler = createReviewControlHandler({ ...control, bindingId: context.binding.bindingId });
  let dispose: (() => void) | null = null;
  let starting: Promise<void> | null = null;
  // Each stop invalidates every start still waiting on recovery.
  let epoch = 0;

  return Object.freeze({
    id: 'review' as const,
    state: 'ready' as const,
    start() {
      if (dispose !== null) return Promise.resolve();
      if (starting !== null) return starting;
      const token = epoch;
      const run = async (): Promise<void> => {
        try {
          // A release committed before a crash reaches the dispatcher before new approvals do.
          await handler.resumeReleases(context.binding.bindingId);
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
      handler.dispose();
    },
  });
}
