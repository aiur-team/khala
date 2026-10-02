import type { RouteRegistration } from '../../runtime/handler';

// Build-time discovery (runtime/discover.ts) needs this agent domain module to
// select hosted-production.ts. KM-133 adds the agent-join routes here.
export function registerAgentHandlers(): readonly RouteRegistration[] {
  return Object.freeze([]);
}
