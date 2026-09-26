// Read-only projections of a verified imported-history archive: one inert view for
// humans and bounded context pages an agent reads on request. Neither produces a
// `TimelineItem`, `EventRef` or subscription event, so imported rows never wake an
// agent, enter a delivery queue or earn a receipt.

import { type Decoded } from '@khala/contracts/messaging/decode';
import {
  type ImportedHistoryActor, type ImportedHistoryLimits, type ImportedHistoryRecord, type ImportedHistorySource,
  openImportedHistory,
} from '@khala/contracts/messaging/imported-history';

/**
 * The archive as humans see it: frozen, in source order, and labelled as imported.
 * `importedBy` is who carried the history across; each record's `originalAuthor` is
 * display provenance from the source channel, never an external participant.
 */
export type ImportedHistoryView = Readonly<{
  kind: 'imported-history';
  archiveId: string;
  source: ImportedHistorySource;
  importedBy: ImportedHistoryActor;
  importedAt: string;
  records: readonly ImportedHistoryRecord[];
}>;

/** A bounded slice an agent reads explicitly. `nextCursor` is null on the last page. */
export type ImportedContextPage = Readonly<{
  archiveId: string;
  records: readonly ImportedHistoryRecord[];
  nextCursor: string | null;
}>;

export type ImportedContextPageResult =
  | Readonly<{ ok: true; page: ImportedContextPage }>
  | Readonly<{ ok: false; reason: 'invalid_request' }>;

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Verifies the whole archive before projecting any of it; a partial or tampered archive yields no view. */
export async function projectImportedHistory(
  manifest: unknown, chunks: unknown, limits: ImportedHistoryLimits,
): Promise<Decoded<ImportedHistoryView>> {
  const opened = await openImportedHistory(manifest, chunks, limits);
  if (!opened.ok) return opened;
  const { manifest: verified, records } = opened.value;
  return {
    ok: true,
    value: freeze({
      kind: 'imported-history',
      archiveId: verified.archiveId,
      source: { ...verified.source },
      importedBy: { ...verified.importedBy },
      importedAt: verified.importedAt,
      records: records.map(record => ({ ...record, originalAuthor: { ...record.originalAuthor } })),
    }),
  };
}

const CURSOR = /^(0|[1-9][0-9]*)$/;

/**
 * Returns records after `cursor` (the last sequence already read), at most
 * `min(limit, maxPageRecords)` of them and at most `maxPageBytes` of body. A page
 * always holds at least one record when any remain, because the limits guarantee one
 * maximum-sized body fits. Reading a page has no side effects.
 */
export function importedContextPage(
  view: ImportedHistoryView,
  request: Readonly<{ cursor: string | null; limit: number }>,
  limits: ImportedHistoryLimits,
): ImportedContextPageResult {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) return { ok: false, reason: 'invalid_request' };
  let after = -1;
  if (request.cursor !== null) {
    if (!CURSOR.test(request.cursor)) return { ok: false, reason: 'invalid_request' };
    after = Number(request.cursor);
    if (!Number.isSafeInteger(after)) return { ok: false, reason: 'invalid_request' };
  }
  const maxRecords = Math.min(request.limit, limits.maxPageRecords);
  const encoder = new TextEncoder();
  const records: ImportedHistoryRecord[] = [];
  let bytes = 0;
  let start = view.records.findIndex(record => record.sequence > after);
  if (start === -1) start = view.records.length;
  let position = start;
  for (; position < view.records.length && records.length < maxRecords; position += 1) {
    const record = view.records[position]!;
    const size = encoder.encode(record.body).byteLength;
    if (records.length > 0 && bytes + size > limits.maxPageBytes) break;
    records.push(record);
    bytes += size;
  }
  const nextCursor = position < view.records.length && records.length > 0 ? String(records.at(-1)!.sequence) : null;
  return { ok: true, page: Object.freeze({ archiveId: view.archiveId, records: Object.freeze(records), nextCursor }) };
}
