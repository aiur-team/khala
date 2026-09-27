import {
  AUTHORIZE_PATH, DESCRIPTOR_PATH, REDEEM_PATH, TOKEN_PATH, REFRESH_CHALLENGE_PATH, REFRESH_PATH,
  type AgentBootstrapHandlers,
} from '../../agent-bootstrap/handler';
import type { RouteRegistration } from '../../runtime/handler';

export type LoadBootstrapHandlers = (request: Request) => AgentBootstrapHandlers | Promise<AgentBootstrapHandlers>;

/**
 * Netlify discovers fixed route metadata at build time. Resolve the owner-bound
 * service only when a request arrives, so an authenticated browser request and
 * the matching one-use connector exchange share the same durable control store.
 */
export function createLazyBootstrapRoutes(load: LoadBootstrapHandlers): Readonly<{
  human: readonly RouteRegistration[];
  agent: readonly RouteRegistration[];
}> {
  const route = (domain: 'human' | 'agent', path: string, methods: readonly string[]): RouteRegistration => ({
    path,
    methods,
    async handle(request) {
      const handlers = await load(request);
      const registration = handlers[domain].find(candidate => candidate.path === path);
      if (!registration || methods.length !== registration.methods.length
        || !methods.every(method => registration.methods.includes(method))) {
        throw new Error(`bootstrap route missing: ${path}`);
      }
      return registration.handle(request);
    },
  });
  return {
    human: Object.freeze([route('human', AUTHORIZE_PATH, ['GET', 'POST'])]),
    agent: Object.freeze([
      route('agent', DESCRIPTOR_PATH, ['GET']),
      route('agent', TOKEN_PATH, ['POST']),
      route('agent', REDEEM_PATH, ['POST']),
      route('agent', REFRESH_CHALLENGE_PATH, ['GET']),
      route('agent', REFRESH_PATH, ['POST']),
    ]),
  };
}
