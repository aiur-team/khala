import type { HistoryTransferPort } from '@khala/contracts/messaging/externalization';
import { type ImportedHistoryTransport, deliverImportedPart } from '@khala/messaging/channels/history-import';
import { type HistoryExportDeps, createHistoryExport } from '../externalization/history-export';

// Composition root for history transfer: the internal export writes every archive part
// through the external channel's end-to-end encrypted imported-history transport.

export type ComposedHistoryExportDeps = Omit<HistoryExportDeps, 'deliver'> & Readonly<{ transport: ImportedHistoryTransport }>;

export function createComposedHistoryExport({ transport, ...deps }: ComposedHistoryExportDeps): HistoryTransferPort {
  return createHistoryExport({
    ...deps,
    deliver: (roomId, part, options) => deliverImportedPart(transport, roomId, part, options),
  });
}
