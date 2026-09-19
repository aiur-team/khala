import { createHash } from 'node:crypto';
import { type BootstrapPorts, type SessionClaim, bootstrapAgent } from '@khala/connector/bootstrap/index';
import type { AgentClientPort } from '../cli/types.js';

export type ConnectorBootstrapClientOptions = Readonly<{
  ports: BootstrapPorts; session: SessionClaim; send: AgentClientPort['send']; status: AgentClientPort['status'];
}>;
export function createConnectorBootstrapClient(options: ConnectorBootstrapClientOptions): AgentClientPort {
  return {
    async connect(link) {
      const operationId = createHash('sha256')
        .update(JSON.stringify(['khala.agent-cli.bootstrap.v1', link, options.session.harness, options.session.sessionId, options.session.workdir]))
        .digest('base64url').slice(0, 32);
      const result = await bootstrapAgent({ chatUrl: link, session: options.session, operationId }, options.ports);
      if (result.kind === 'blocked') return { kind: 'refused', code: result.code };
      if (result.kind === 'unavailable') return { kind: 'unavailable' };
      return result;
    },
    send: options.send,
    status: options.status,
  };
}
