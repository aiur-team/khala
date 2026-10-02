import type { RouteRegistration } from '../runtime/handler';
import { registerAgentHandlers } from './agent/handlers';
import { registerHumanHandlers } from './human/handlers';
import type { ProductionHumanDependencies } from './human/production';
import { createHostedHumanChannelLinkRoutes } from '../channel-link/production';

export type HostedProductionOptions = ProductionHumanDependencies;

/** The generated Netlify function calls this exact composition root. */
export function registerHostedProductionRoutes(options: HostedProductionOptions = {}): readonly RouteRegistration[] {
  return Object.freeze([
    ...registerHumanHandlers({ channelLink: () => createHostedHumanChannelLinkRoutes(options) }),
    ...registerAgentHandlers(),
  ]);
}
