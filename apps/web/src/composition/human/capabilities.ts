import { registerControls } from '../controls/register';
import { registerRecovery } from '../recovery/register';
import { registerReview } from '../review/register';
import type { HumanRouteContext } from './application';
import type { Disposer } from '@khala/contracts/messaging/index';

export type HumanCapability = {
  state: 'unavailable' | 'ready';
  id: 'review' | 'controls' | 'recovery';
  attach: (context: HumanRouteContext) => { dispose: () => void };
};

/**
 * The complete, reviewed set of optional human-route extensions.
 *
 * Keep this list literal: URLs and other request data must never select code
 * to load. Follow-on owners replace their registration module in place.
 */
export function registerHumanCapabilities(): readonly HumanCapability[] {
  return [registerReview(), registerControls(), registerRecovery()];
}

/** Attaches only compiled, ready capabilities to one route-scoped context. */
export function attachHumanCapabilities(
  capabilities: readonly HumanCapability[],
  context: HumanRouteContext,
): Disposer {
  const releases = capabilities
    .filter(capability => capability.state === 'ready')
    .map(capability => context.registerDisposer(capability.attach(context).dispose));
  return () => {
    for (const release of releases.reverse()) release();
  };
}
