import type { AgentJoinView } from '@khala/contracts/m1/agent-join';

export type AgentJoinError = 'signed_out' | 'not_member' | 'not_found' | 'already_confirmed_by_other' | 'unavailable';
export type AgentJoinResult = { kind: 'ok'; view: AgentJoinView } | { kind: 'error'; code: AgentJoinError };
export interface AgentJoinPort {
  view(joinId: string, signal?: AbortSignal): Promise<AgentJoinResult>;
  confirm(joinId: string, signal?: AbortSignal): Promise<AgentJoinResult>;
  status(joinId: string, signal?: AbortSignal): Promise<AgentJoinResult>;
}
export type AgentInvitePort = (roomId: string, agentUserId: string) => Promise<boolean>;
