import { createHash } from 'node:crypto';
import type { JoinRecord } from './store';
import type { OwnerId } from '@khala/contracts/messaging/index';

/** A secret proves possession only within this room, harness and session. */
export function rejoinIdentity(record: JoinRecord): string | undefined {
  if (record.sessionId === undefined || record.rejoinSecretHash === undefined) return;
  return 'session.' + createHash('sha256').update(JSON.stringify([record.roomId, record.harness, record.sessionId, record.rejoinSecretHash])).digest('hex');
}
export const rejoinApprovalKey = (identity: string) => `agent-rejoin-approval.v1.${identity}`;
export type RejoinApproval = { v: 1; ownerId: OwnerId; ownerLabel: string; generation: number };
export function validRejoinApproval(value: unknown): value is RejoinApproval {
  if (!value || typeof value !== 'object') return false;
  const r = value as RejoinApproval;
  return r.v === 1 && typeof r.ownerId === 'string' && r.ownerId.length > 0 && typeof r.ownerLabel === 'string'
    && r.ownerLabel.length > 0 && Number.isSafeInteger(r.generation) && r.generation >= 0;
}
