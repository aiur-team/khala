import type { RouteRegistration } from '../../runtime/handler';

const unavailableStatus: RouteRegistration = Object.freeze({
  path: '/api/agent/status',
  methods: Object.freeze(['GET']),
  async handle() {
    return new Response(JSON.stringify({ code: 'feature_unavailable' }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
});

export function registerAgentHandlers(): readonly RouteRegistration[] {
  return Object.freeze([unavailableStatus]);
}
