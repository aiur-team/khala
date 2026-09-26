import { createHash } from 'node:crypto';
import { type BootstrapPorts, type SessionClaim, bootstrapAgent } from '@khala/connector/bootstrap/index';
import { CONNECT_REFUSAL_CODES, PAIR_REFUSAL_CODES, type AgentClientPort, type ConnectRefusalCode, type PairRefusalCode } from '../cli/types.js';

export type ConnectorBootstrapClientOptions = Readonly<{
  ports: BootstrapPorts; session: SessionClaim; send: AgentClientPort['send']; status: AgentClientPort['status'];
  listChannels: AgentClientPort['listChannels']; listAgents: AgentClientPort['listAgents'];
}>;
export function createConnectorBootstrapClient(options: ConnectorBootstrapClientOptions): AgentClientPort {
  const { session } = options;
  return {
    async connect(link) {
      const operationId = createHash('sha256')
        .update(JSON.stringify(['khala.agent-cli.bootstrap.v1', link, session.harness, session.sessionId, session.workdir]))
        .digest('base64url').slice(0, 32);
      const result = await bootstrapAgent({ channelUrl: link, session, operationId }, options.ports);
      if (result.kind === 'blocked') {
        return (CONNECT_REFUSAL_CODES as readonly string[]).includes(result.code)
          ? { kind: 'refused', code: result.code as ConnectRefusalCode }
          : { kind: 'unavailable' };
      }
      if (result.kind === 'unavailable' || result.kind === 'pending') return { kind: 'unavailable' };
      return result;
    },
    ...(options.ports.pairing === undefined || options.ports.discovery.resolvePairing === undefined ? {} : {
      async pair(code: string, signal?: AbortSignal) {
        // Stable per code and session, so pairing again with the same code resumes the same claim.
        const operationId = createHash('sha256')
          .update(JSON.stringify(['khala.agent-cli.pairing.v1', code, session.harness, session.sessionId, session.workdir]))
          .digest('base64url').slice(0, 32);
        const result = await bootstrapAgent(
          { pairingCode: code, session, operationId }, options.ports, signal === undefined ? {} : { signal },
        );
        if (result.kind === 'blocked') {
          return (PAIR_REFUSAL_CODES as readonly string[]).includes(result.code)
            ? { kind: 'refused', code: result.code as PairRefusalCode }
            : { kind: 'unavailable' };
        }
        if (result.kind === 'pending') return { kind: 'pending', reason: result.reason };
        if (result.kind === 'unavailable') return { kind: 'unavailable' };
        return result;
      },
    }),
    send: options.send,
    status: options.status,
    listChannels: options.listChannels,
    listAgents: options.listAgents,
  };
}
