// Imported-history traffic on the external channel. Archive parts travel through the
// destination channel's end-to-end encryption but on their own transport surface, never
// as timeline messages: nothing here produces a `SubstrateEvent`, a `TimelineItem` or a
// subscription update, so an imported record cannot wake an agent, enter a delivery
// queue or earn a receipt. Agents read the archive only by paging it explicitly.

import {
  type CallOptions, type OperationResult, type RoomId, type ChannelRejection, ok, outcomeUnknown, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import type { DecodeError } from '@khala/contracts/messaging/decode';
import {
  type ImportedHistoryChunk, type ImportedHistoryLimits, type ImportedHistoryManifest, decodeImportedHistoryManifest,
  digestImportedHistoryManifest,
} from '@khala/contracts/messaging/imported-history';
import { type ImportedHistoryView, projectImportedHistory } from './imported-history';
import type { SubstrateEffect, SubstrateRead } from './substrate';

/** One archive write: a sealed chunk, or the manifest that closes the archive. */
export type ImportedHistoryPart =
  | Readonly<{ kind: 'chunk'; archiveId: string; index: number; chunk: ImportedHistoryChunk }>
  | Readonly<{ kind: 'manifest'; archiveId: string; manifest: ImportedHistoryManifest }>;

/** Outcome of looking up a part by its transaction ID; `absent` must be a proof, as for `CreateLookup`. */
export type ImportedPartLookup =
  | Readonly<{ kind: 'found'; partId: string }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Every accepted part of one archive, as stored; the reader verifies them, never the transport. */
export type ImportedArchiveParts = Readonly<{ manifest: unknown | null; chunks: readonly unknown[] }>;

/**
 * The provider seam for archive parts. An adapter encrypts every part with the
 * destination channel's end-to-end keys, as the signed-in owner's participant, and
 * keeps parts out of `ChannelSubstrate.timeline` and `subscribe`. The transport
 * deduplicates on `clientTxnId`, so re-sending a part never stores a second copy.
 * Provider support is unproven until an adapter passes integration.
 */
export interface ImportedHistoryTransport {
  putPart(
    input: Readonly<{ roomId: RoomId; clientTxnId: string; part: ImportedHistoryPart }>, options?: CallOptions,
  ): Promise<SubstrateEffect<Readonly<{ partId: string }>>>;
  findPart(input: Readonly<{ roomId: RoomId; clientTxnId: string }>, options?: CallOptions): Promise<ImportedPartLookup>;
  readParts(input: Readonly<{ roomId: RoomId; archiveId: string }>, options?: CallOptions): Promise<SubstrateRead<ImportedArchiveParts>>;
}

/** The deterministic transaction ID of a part, so a retry of the same part is the same write. */
export function importedPartTxnId(part: Pick<ImportedHistoryPart, 'kind' | 'archiveId'> & Readonly<{ index?: number }>): string {
  return part.kind === 'manifest' ? `${part.archiveId}.manifest` : `${part.archiveId}.chunk.${part.index}`;
}

async function settle<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

/**
 * Writes one part at most once. A part already accepted under its transaction ID is
 * reconciled from the transport instead of re-sent, so a lost acknowledgement never
 * duplicates records. `outcome_unknown` means the part may have landed; the caller
 * retries the same part and this call reconciles it.
 */
export async function deliverImportedPart(
  transport: ImportedHistoryTransport, roomId: RoomId, part: ImportedHistoryPart, options?: CallOptions,
): Promise<OperationResult<Readonly<{ partId: string; reconciled: boolean }>, ChannelRejection>> {
  const clientTxnId = importedPartTxnId(part.kind === 'chunk' ? part : { kind: 'manifest', archiveId: part.archiveId });
  const found = await settle(() => transport.findPart({ roomId, clientTxnId }, options), { kind: 'unavailable' } as const);
  if (found.kind === 'found') return ok({ partId: found.partId, reconciled: true });
  if (found.kind === 'unavailable') return unavailable();
  // `unknown` still sends: the transport deduplicates on the transaction ID.
  const put = await settle(() => transport.putPart({ roomId, clientTxnId, part }, options), { kind: 'unknown' } as const);
  switch (put.kind) {
    case 'done':
      return ok({ partId: put.value.partId, reconciled: false });
    case 'rejected':
      return rejected(put.code);
    case 'unavailable':
      return unavailable();
    case 'unknown':
      return outcomeUnknown(clientTxnId);
  }
}

export type OpenImportedArchiveResult =
  | Readonly<{ ok: true; view: ImportedHistoryView }>
  | Readonly<{ ok: false; reason: 'unavailable' | 'incomplete' | 'manifest_mismatch' }>
  | Readonly<{ ok: false; reason: 'invalid_archive'; error: DecodeError }>;

/**
 * Reads an archive back from the destination and projects it only when the stored
 * manifest is exactly the one the transfer finished with (`manifestDigest`) and every
 * chunk verifies against it. The digests are unkeyed; authenticity comes from the
 * channel's end-to-end encryption, and `manifestDigest` from the conversion journal.
 */
export async function openImportedArchive(
  transport: ImportedHistoryTransport,
  input: Readonly<{ roomId: RoomId; archiveId: string; manifestDigest: string; limits: ImportedHistoryLimits }>,
  options?: CallOptions,
): Promise<OpenImportedArchiveResult> {
  const read = await settle(
    () => transport.readParts({ roomId: input.roomId, archiveId: input.archiveId }, options), { kind: 'unavailable' } as const,
  );
  if (read.kind !== 'done') return { ok: false, reason: 'unavailable' };
  if (read.value.manifest === null) return { ok: false, reason: 'incomplete' };
  const manifest = decodeImportedHistoryManifest(read.value.manifest, input.limits);
  if (!manifest.ok) return { ok: false, reason: 'invalid_archive', error: manifest.error };
  // The digest is taken over the decoded manifest's canonical encoding, not the stored bytes.
  const digest = await digestImportedHistoryManifest(manifest.value);
  if (!digest.ok || digest.value !== input.manifestDigest || manifest.value.archiveId !== input.archiveId) {
    return { ok: false, reason: 'manifest_mismatch' };
  }
  const projected = await projectImportedHistory(read.value.manifest, read.value.chunks, input.limits);
  if (!projected.ok) return { ok: false, reason: 'invalid_archive', error: projected.error };
  return { ok: true, view: projected.value };
}
