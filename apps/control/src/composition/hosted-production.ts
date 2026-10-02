import type { RouteRegistration } from '../runtime/handler';
import { registerAgentHandlers } from './agent/handlers';
import { registerHumanHandlers } from './human/handlers';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies } from './human/production';
import { createHostedHumanChannelLinkRoutes } from '../channel-link/production';

import { createAgentJoinRoutes } from '../agent-join/production';
import { createProfileRoutes } from '../profile/production';

export type HostedProductionOptions = ProductionHumanDependencies;

/** The generated Netlify function calls this exact composition root. */
export function registerHostedProductionRoutes(options: HostedProductionOptions = {}): readonly RouteRegistration[] {
  const runtime = createProductionHumanRuntimeLoader(options);
  return Object.freeze([
    ...registerHumanHandlers({ channelLink: () => createHostedHumanChannelLinkRoutes(options) }),
    ...registerAgentHandlers(),
    ...createAgentJoinRoutes(runtime, options.fetch),
    ...createProfileRoutes(runtime, options.fetch),
  ]);
}
