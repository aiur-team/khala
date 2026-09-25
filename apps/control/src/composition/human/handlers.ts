import type { RouteRegistration } from '../../runtime/handler';

export type HumanHandlerDependencies = Readonly<{
  /** Request-lifetime live pairing registrations supplied by the composition root. */
  pairing?: () => readonly RouteRegistration[];
  /** Request-lifetime discovery-bootstrap registrations supplied by the composition root. */
  channelDiscoveryBootstrap?: () => readonly RouteRegistration[];
  /** Request-lifetime channel-discovery settings registrations supplied by the composition root. */
  channelDiscovery?: () => readonly RouteRegistration[];
}>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function unavailable(path: string, methods: readonly string[]): RouteRegistration {
  return Object.freeze({
    path,
    methods: Object.freeze(methods),
    async handle() {
      return json(503, { v: 1, kind: 'rejected', code: 'feature_unavailable' });
    },
  });
}

const unavailablePairingRoutes = Object.freeze([
  unavailable('/api/human/pairing/request', ['POST', 'GET']),
  unavailable('/api/human/pairing/decision', ['POST']),
]);

const unavailableChannelDiscoveryRoutes = Object.freeze([
  Object.freeze({
    path: '/api/human/channel-discovery/bootstrap/authorize',
    methods: Object.freeze(['GET', 'POST']),
    async handle() {
      return json(503, { error: 'feature_unavailable' });
    },
  }),
]);

const unavailableChannelSettingsRoutes = Object.freeze([
  unavailable('/api/human/channel-discovery/settings', ['PUT']),
  unavailable('/api/human/channel-discovery/allowlist', ['POST']),
  unavailable('/api/human/channel-discovery/rollout', ['PUT']),
]);

export function registerHumanHandlers(dependencies?: HumanHandlerDependencies): readonly RouteRegistration[] {
  return Object.freeze([
    ...(dependencies?.pairing?.() ?? unavailablePairingRoutes),
    ...(dependencies?.channelDiscoveryBootstrap?.() ?? unavailableChannelDiscoveryRoutes),
    ...(dependencies?.channelDiscovery?.() ?? unavailableChannelSettingsRoutes),
  ]);
}
