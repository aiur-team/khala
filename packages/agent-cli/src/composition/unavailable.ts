import type { AgentClientPort } from '../cli/types.js';
export function createUnavailableClient(): AgentClientPort {
  return {
    async connect() { return { kind: 'unavailable' }; },
    async send(input) { return { kind: 'refused', code: 'transport_unavailable', clientTxnId: input.clientTxnId }; },
    async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
  };
}
