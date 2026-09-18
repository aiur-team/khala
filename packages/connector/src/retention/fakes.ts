// Test double for the KHA-115 ledger seam. Each method body runs without an await,
// so it is one atomic step, like a local transaction. It models the port contract
// only; the real ledger proves the same behaviour when KHA-115 lands.

import type { EventId } from '@khala/contracts/delivery/ids';
import type { ClaimStatus, RetentionRecord } from './eligibility';
import type {
  ActiveClaimPort, ApplyResult, RecordPage, RetentionOperation, RetentionRecordPort, SupportedCryptoMaintenancePort,
  SweepCursor,
} from './sweep';

type Entry = { record: RetentionRecord; bytes: string | null };
type Approval = { recordId: string; status: 'pending' | 'released' | 'content_unavailable' };

export type LedgerFault = 'ok' | 'unavailable' | 'lost_applied' | 'throw';

export type PayloadRead =
  | Readonly<{ kind: 'bytes'; bytes: string }>
  | Readonly<{ kind: 'content_deleted'; eventId: EventId }>
  | Readonly<{ kind: 'absent' }>;

export type ApproveResult =
  | Readonly<{ kind: 'released'; bytes: string }>
  | Readonly<{ kind: 'content_unavailable' }>
  | Readonly<{ kind: 'not_found' }>;

export function memoryLedger(policyVersion: number) {
  const entries = new Map<string, Entry>();
  const approvals = new Map<string, Approval>();
  const claims = new Map<string, ClaimStatus>();
  const applied = new Set<string>();
  let cursor: SweepCursor | null = null;
  let revision = 0;
  const faults = {
    page: [] as LedgerFault[], apply: [] as LedgerFault[], readCursor: [] as LedgerFault[], writeCursor: [] as LedgerFault[],
  };
  const hooks: { beforeApply: ((operation: RetentionOperation) => void) | null } = { beforeApply: null };
  const calls = { apply: [] as RetentionOperation[], crypto: 0 };
  const bump = (entry: Entry, change: Partial<RetentionRecord>): void => {
    revision += 1;
    entry.record = { ...entry.record, ...change, revision: `rev${revision}` };
  };
  const fault = (queue: LedgerFault[]): LedgerFault => {
    const next = queue.shift() ?? 'ok';
    if (next === 'throw') throw new Error('disk failure');
    return next;
  };

  const ledger = {
    policyVersion,
    now: '2026-09-18T12:00:00Z',
    add(record: Omit<RetentionRecord, 'revision'>, bytes: string | null = `bytes:${record.recordId}`): void {
      revision += 1;
      entries.set(record.recordId, { record: { ...record, revision: `rev${revision}` }, bytes });
    },
    /** The owner sees pending content and an approval is created against it. */
    display(approvalId: string, recordId: string): void {
      approvals.set(approvalId, { recordId, status: 'pending' });
    },
    /** Approval and release in one transaction: it either wins with the bytes or finds them gone. */
    approve(approvalId: string, at: string): ApproveResult {
      const approval = approvals.get(approvalId);
      if (!approval) return { kind: 'not_found' };
      const entry = entries.get(approval.recordId);
      if (approval.status === 'content_unavailable' || !entry || entry.bytes === null) {
        approval.status = 'content_unavailable';
        return { kind: 'content_unavailable' };
      }
      approval.status = 'released';
      bump(entry, { state: 'released', releasedAt: at });
      return { kind: 'released', bytes: entry.bytes };
    },
    claim(recordId: string, status: ClaimStatus): void {
      claims.set(recordId, status);
      const entry = entries.get(recordId);
      if (entry) bump(entry, {});
    },
    readPayload(recordId: string): PayloadRead {
      const entry = entries.get(recordId);
      if (!entry) return { kind: 'absent' };
      return entry.bytes === null ? { kind: 'content_deleted', eventId: entry.record.eventId } : { kind: 'bytes', bytes: entry.bytes };
    },
    /** Replay of a transport event: a remembered identity is a duplicate, not new review content. */
    ingest(eventId: EventId): 'duplicate' | 'new' {
      return [...entries.values()].some(entry => entry.record.eventId === eventId) ? 'duplicate' : 'new';
    },
    approvalStatus(approvalId: string): Approval['status'] | undefined {
      return approvals.get(approvalId)?.status;
    },
    get cursor() {
      return cursor;
    },
    entries,
    faults,
    hooks,
    calls,
  };

  const records: RetentionRecordPort = {
    async page({ after, limit }): Promise<RecordPage> {
      if (fault(faults.page) === 'unavailable') return { kind: 'unavailable' };
      const ordered = [...entries.values()].map(entry => entry.record)
        .filter(record => after === null || record.recordId > after)
        .sort((a, b) => (a.recordId < b.recordId ? -1 : 1));
      return { kind: 'page', records: ordered.slice(0, limit), exhausted: ordered.length <= limit };
    },
    async readCursor() {
      if (fault(faults.readCursor) === 'unavailable') return { kind: 'unavailable' };
      return { kind: 'cursor', cursor };
    },
    async writeCursor(next) {
      if (fault(faults.writeCursor) === 'unavailable') return { kind: 'unavailable' };
      cursor = next;
      return { kind: 'written' };
    },
    async apply(operation): Promise<ApplyResult> {
      calls.apply.push(operation);
      hooks.beforeApply?.(operation);
      const injected = fault(faults.apply);
      if (injected === 'unavailable') return { kind: 'unavailable' };
      // One transaction from here: compare, validate references, delete, invalidate.
      if (applied.has(operation.operationId)) return { kind: 'already_applied' };
      if (operation.policyVersion !== ledger.policyVersion) return { kind: 'stale_policy' };
      const entry = entries.get(operation.recordId);
      if (!entry || entry.record.revision !== operation.expectedRevision) return { kind: 'conflict' };
      const claim = claims.get(operation.recordId) ?? 'none';
      if (claim === 'active' || claim === 'outcome_unknown') return { kind: 'referenced' };
      let invalidatedApprovals = 0;
      if (operation.action === 'delete_payload') {
        if (entry.record.state === 'tombstone') return { kind: 'conflict' };
        for (const approval of approvals.values()) {
          if (approval.recordId === operation.recordId && approval.status === 'pending') {
            approval.status = 'content_unavailable';
            invalidatedApprovals += 1;
          }
        }
        entry.bytes = null;
        bump(entry, { state: 'tombstone', tombstonedAt: ledger.now });
      } else {
        if (entry.record.state !== 'tombstone') return { kind: 'conflict' };
        entries.delete(operation.recordId);
      }
      applied.add(operation.operationId);
      return injected === 'lost_applied' ? { kind: 'outcome_unknown' } : { kind: 'applied', invalidatedApprovals };
    },
  };

  const claimPort: ActiveClaimPort = {
    async status(recordId) {
      return claims.get(recordId) ?? 'none';
    },
  };

  const crypto: SupportedCryptoMaintenancePort = {
    async maintain() {
      calls.crypto += 1;
      return { kind: 'unsupported' };
    },
  };

  return Object.assign(ledger, { records, claimPort, crypto });
}
