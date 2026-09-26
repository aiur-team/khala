// Test-only in-memory conversion journal. Not exported from the package index; the
// conversion service and the history export both build against it without importing
// each other.

import {
  CONVERSION_VERSION, type ConversionJournalPort, type ConversionRecord, isAllowedTransition,
} from './externalization';
import { ok, rejected } from './outcomes';

/**
 * In-memory journal that reproduces the semantics every adapter must have: operation
 * IDs are idempotent, stale revisions lose, and only listed transitions are accepted.
 */
export function createFakeConversionJournal(): ConversionJournalPort {
  const records = new Map<string, ConversionRecord>();
  const operations = new Map<string, Readonly<{ fingerprint: string; record: ConversionRecord }>>();

  return {
    async create(input) {
      const fingerprint = JSON.stringify(['create', input.conversionId, input.historyMode]);
      const replay = operations.get(input.operationId);
      if (replay) return replay.fingerprint === fingerprint ? ok(replay.record) : rejected('operation_mismatch');
      if (records.has(input.conversionId)) return rejected('operation_mismatch');
      const record: ConversionRecord = {
        v: CONVERSION_VERSION, conversionId: input.conversionId, operationId: input.operationId,
        historyMode: input.historyMode, state: 'preparing', revision: 0,
      };
      records.set(record.conversionId, record);
      operations.set(input.operationId, { fingerprint, record });
      return ok(record);
    },
    async read(conversionId) {
      const record = records.get(conversionId);
      return record ? ok(record) : rejected('not_found');
    },
    async advance(input) {
      const fingerprint = JSON.stringify(['advance', input.conversionId, input.expectedRevision, input.from, input.to]);
      const replay = operations.get(input.operationId);
      if (replay) return replay.fingerprint === fingerprint ? ok(replay.record) : rejected('operation_mismatch');
      const current = records.get(input.conversionId);
      if (!current) return rejected('not_found');
      if (current.revision !== input.expectedRevision || current.state !== input.from) return rejected('stale_revision');
      if (!isAllowedTransition(input.from, input.to)) return rejected('invalid_transition');
      const record: ConversionRecord = { ...current, state: input.to, revision: current.revision + 1 };
      records.set(record.conversionId, record);
      operations.set(input.operationId, { fingerprint, record });
      return ok(record);
    },
  };
}
