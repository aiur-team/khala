import { registerControls } from '../controls/register';
import { registerRecovery } from '../recovery/register';
import { registerReview } from '../review/register';
import type { HumanRouteContext } from './application';

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
