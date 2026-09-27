// Owns one channel's receipt evidence read. Access is modelled apart from the
// facts: a failed read keeps the last facts it had but can never confirm that a
// fact is absent. The first successful read is hydration and stays silent; each
// fact first observed after it is announced exactly once.

import type { ReceiptId } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/ids';
import { type EvidenceUnit, type ReceiptEvidenceFact, type ReceiptEvidenceRead, evidenceUnits } from './model';
import { inCanonicalOrder, receiptEvidenceLabel } from './vocabulary';

export type ReceiptEvidenceStatus = 'loading' | 'ready' | 'partial' | 'unavailable';

export interface ReceiptEvidencePort {
  read(channelId: RoomId, signal: AbortSignal): Promise<ReceiptEvidenceRead>;
}

export type ReceiptEvidenceView = Readonly<{
  status: ReceiptEvidenceStatus;
  units: readonly EvidenceUnit[];
  /** The latest polite announcement; `sequence` changes each time new facts are announced. */
  announcement: Readonly<{ sequence: number; text: string }> | null;
}>;

export interface ReceiptEvidenceController {
  getSnapshot(): ReceiptEvidenceView;
  subscribe(listener: () => void): () => void;
  /** Rereads the evidence; concurrent calls share one request. */
  refresh(): Promise<void>;
  dispose(): void;
}

export function createReceiptEvidenceController(port: ReceiptEvidencePort, channelId: RoomId): ReceiptEvidenceController {
  let view: ReceiptEvidenceView = { status: 'loading', units: [], announcement: null };
  let facts: readonly ReceiptEvidenceFact[] = [];
  let hydrated = false;
  const seen = new Set<ReceiptId>();
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  let inFlight: Promise<void> | null = null;

  function publish(next: ReceiptEvidenceView): void {
    view = next;
    for (const listener of listeners) listener();
  }

  function apply(read: ReceiptEvidenceRead): void {
    if (read.kind === 'unavailable') {
      publish({ ...view, status: 'unavailable' });
      return;
    }
    const fresh = inCanonicalOrder(read.facts.map(fact => fact.receipt).filter(receipt => !seen.has(receipt.receiptId)));
    for (const receipt of fresh) seen.add(receipt.receiptId);
    // A partial read may have dropped facts it already showed; keep them rather than unshow evidence.
    const kept = read.kind === 'partial'
      ? [...read.facts, ...facts.filter(old => !read.facts.some(fact => fact.receipt.receiptId === old.receipt.receiptId))]
      : read.facts;
    facts = kept;
    const announce = hydrated && fresh.length > 0;
    hydrated = true;
    publish({
      status: read.kind,
      units: evidenceUnits(kept),
      announcement: announce
        ? { sequence: (view.announcement?.sequence ?? 0) + 1, text: `New delivery evidence: ${fresh.map(receiptEvidenceLabel).join('; ')}.` }
        : view.announcement,
    });
  }

  async function perform(): Promise<void> {
    let read: ReceiptEvidenceRead;
    try {
      read = await port.read(channelId, abort.signal);
    } catch {
      read = { kind: 'unavailable' };
    }
    if (!abort.signal.aborted) apply(read);
  }

  return {
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh() {
      if (abort.signal.aborted) return Promise.resolve();
      inFlight ??= perform().finally(() => { inFlight = null; });
      return inFlight;
    },
    dispose() {
      abort.abort();
      listeners.clear();
    },
  };
}
