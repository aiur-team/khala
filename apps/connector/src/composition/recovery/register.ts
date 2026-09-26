import {
  unavailableCapability,
  type ConnectorCapability,
  type ConnectorCapabilityContext,
} from '../../runtime/capabilities';
import { type RecoveryLifecycle, type RecoveryLifecycleDeps, bindRecoveryLifecycle } from './lifecycle';

export type RecoveryCapabilityDependencies = Readonly<{
  /**
   * Binds the lifecycle to the opened ledger and dispatcher for the running binding. Absent until
   * the composition root supplies real storage, so the capability stays unavailable.
   */
  lifecycle?: (context: ConnectorCapabilityContext) => Omit<RecoveryLifecycleDeps, 'binding'>;
  /** Receives the bound lifecycle, for owner-facing observation and cleanup. */
  onLifecycle?: (lifecycle: RecoveryLifecycle | null) => void;
}>;

export type RecoveryCapabilityContext = ConnectorCapabilityContext & Readonly<{
  dependencies: RecoveryCapabilityDependencies;
}>;

/**
 * Ready only once the restored ledger reconciled with dispatch allowed. A blocked or unavailable
 * inspection keeps the capability unavailable, so a runtime that requires recovery never dispatches.
 * `stop` closes only this lifecycle, never the shared ledger or dispatcher.
 */
export function registerRecovery(context: RecoveryCapabilityContext): ConnectorCapability {
  const bind = context.dependencies.lifecycle;
  if (!bind) return unavailableCapability('recovery');
  // The runtime re-evaluates readiness after each capability starts, so the settled state is read then.
  const lifecycle = bindRecoveryLifecycle({ ...bind(context), binding: context.binding });
  return Object.freeze({
    id: 'recovery' as const,
    get state() {
      return lifecycle.observe().state === 'ready' ? 'ready' as const : 'unavailable' as const;
    },
    async start() {
      context.dependencies.onLifecycle?.(lifecycle);
      await lifecycle.start();
    },
    async stop() {
      lifecycle.stop();
      context.dependencies.onLifecycle?.(null);
    },
  });
}
