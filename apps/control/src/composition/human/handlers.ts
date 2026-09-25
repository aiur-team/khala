import type { RouteRegistration } from '../../runtime/handler';

export type HumanHandlerDependencies = Readonly<{
  /** Request-lifetime live pairing registrations supplied by the composition root. */
  pairing: () => readonly RouteRegistration[];
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

export function registerHumanHandlers(dependencies?: HumanHandlerDependencies): readonly RouteRegistration[] {
  return dependencies ? Object.freeze([...dependencies.pairing()]) : unavailablePairingRoutes;
}
