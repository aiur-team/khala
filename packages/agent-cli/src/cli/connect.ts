import { publicConnectResult, validLink } from './runtime.js';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { AgentClientPort, ConnectRefusalCode } from './types.js';

export type ConnectOutput =
  | Readonly<{ ok: true; binding: SessionBinding; reused: boolean }>
  | Readonly<{ ok: true; operationId: string; outcome: 'pending_owner' | 'connecting' | 'repair_required'; next: 'human_approve' | 'retry_same_link' | 'repair_connector' }>
  | Readonly<{ ok: false; error: ConnectRefusalCode | 'invalid_link' | 'unavailable' }>;

/** Shared link bootstrap for the CLI and provider-context MCP entry. */
export class ConnectService {
  constructor(private readonly client: Pick<AgentClientPort, 'connect'>) {}

  async connect(link: unknown, signal?: AbortSignal): Promise<ConnectOutput> {
    if (typeof link !== 'string' || !validLink(link)) return { ok: false, error: 'invalid_link' } as const;
    try {
      const result = publicConnectResult(await this.client.connect(link, signal));
      if (result.kind === 'connected') return { ok: true, binding: result.binding, reused: result.reused } as const;
      if (result.kind === 'pending') return { ok: true, operationId: result.operationId, outcome: result.outcome,
        next: result.outcome === 'pending_owner' ? 'human_approve'
          : result.outcome === 'repair_required' ? 'repair_connector' : 'retry_same_link' } as const;
      return { ok: false, error: result.kind === 'refused' ? result.code : 'unavailable' } as const;
    } catch {
      return { ok: false, error: 'unavailable' } as const;
    }
  }
}
