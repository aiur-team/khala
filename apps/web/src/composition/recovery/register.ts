import type { Disposer } from '@khala/contracts/messaging/index';
import type { HumanCapability } from '../human/capabilities';
import type { HumanRouteContext } from '../human/application';
import { type BrowserRecoveryPorts, type BrowserRevocation, createBrowserRecoveryPort } from './browser-port';

export type RecoveryRegistrationDeps = Readonly<{
  /**
   * Renders the KHA-127 panel into a host slot. The human route has no recovery slot yet,
   * so without it the capability stays unavailable rather than attaching invisible state.
   */
  render?: (context: HumanRouteContext, ports: BrowserRecoveryPorts) => Disposer;
  /** Owner-scoped control-plane revocation. Absent: no target is offered. */
  revocation?: (context: HumanRouteContext) => BrowserRevocation | undefined;
}>;

/**
 * Attaches one recovery port per route context. Disposing it closes the panel and this port's
 * observers only; the shared device and messaging lifecycle stay owned by KHA-132.
 */
export function registerRecovery(deps: RecoveryRegistrationDeps = {}): HumanCapability {
  const { render } = deps;
  if (!render) {
    return { id: 'recovery', state: 'unavailable', attach: () => ({ dispose() {} }) };
  }
  return {
    id: 'recovery',
    state: 'ready',
    attach(context) {
      const revocation = deps.revocation?.(context);
      const ports = createBrowserRecoveryPort({
        principal: context.principal,
        identity: context.identity,
        device: context.device,
        ...(revocation ? { revocation } : {}),
      });
      const unmount = render(context, ports);
      return {
        dispose() {
          unmount();
          ports.dispose();
        },
      };
    },
  };
}
