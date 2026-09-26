import { describe, expect, it } from 'vitest';
import type { RoomId } from '@khala/contracts/messaging/index';
import {
  type ImportedHistoryLimits, type SealedImportedHistory, decodeImportedHistoryLimits, digestImportedHistoryManifest,
  sealImportedHistory,
} from '@khala/contracts/messaging/imported-history';
import {
  type ImportedHistoryPart, type ImportedHistoryTransport, type ImportedPartLookup, deliverImportedPart, importedPartTxnId,
  openImportedArchive,
} from './history-import';
import { importedContextPage } from './imported-history';
import type { SubstrateEffect } from './substrate';

const decoded = decodeImportedHistoryLimits({
  maxBodyBytes: 64, maxAuthorLabelBytes: 64, maxRecordsPerChunk: 2, maxChunkBytes: 4096, maxChunks: 8,
  maxPageRecords: 2, maxPageBytes: 128,
});
if (!decoded.ok) throw new Error('limits');
const limits: ImportedHistoryLimits = decoded.value;
const roomId = 'room-1' as RoomId;

async function seal(): Promise<SealedImportedHistory> {
  const sealed = await sealImportedHistory({
    archiveId: 'archive-1',
    source: { channelId: 'internal-1', revision: '5' },
    importedBy: { ownerId: 'owner-1', participantId: '@ada:example.org' },
    importedAt: '2026-09-25T13:00:00Z',
    records: [1, 2, 3].map(sequence => ({
      sourceRecordId: `event-${sequence}`, sequence, originalAuthor: { label: 'Ada', kind: 'human' },
      originalSentAt: '2026-09-25T12:00:00Z', body: `body ${sequence}\nnext`,
    })),
  }, limits);
  if (!sealed.ok) throw new Error('seal');
  return sealed.value;
}

type Mode = 'ok' | 'lose_ack' | 'unavailable' | 'throw';

function transport(): ImportedHistoryTransport & { stored: Map<string, ImportedHistoryPart>; puts: string[]; mode: Mode; lookups: Mode } {
  const stored = new Map<string, ImportedHistoryPart>();
  const fake = {
    stored,
    puts: [] as string[],
    mode: 'ok' as Mode,
    lookups: 'ok' as Mode,
    async putPart(input: Readonly<{ roomId: RoomId; clientTxnId: string; part: ImportedHistoryPart }>): Promise<SubstrateEffect<{ partId: string }>> {
      if (fake.mode === 'throw') throw new Error('sdk exploded');
      if (fake.mode === 'unavailable') return { kind: 'unavailable' };
      fake.puts.push(input.clientTxnId);
      if (!stored.has(input.clientTxnId)) stored.set(input.clientTxnId, input.part);
      return fake.mode === 'lose_ack' ? { kind: 'unknown' } : { kind: 'done', value: { partId: `part:${input.clientTxnId}` } };
    },
    async findPart(input: Readonly<{ roomId: RoomId; clientTxnId: string }>): Promise<ImportedPartLookup> {
      if (fake.lookups === 'unavailable') return { kind: 'unavailable' };
      return stored.has(input.clientTxnId) ? { kind: 'found', partId: `part:${input.clientTxnId}` } : { kind: 'absent' };
    },
    async readParts() {
      const parts = [...stored.values()];
      const manifest = parts.find(part => part.kind === 'manifest');
      return {
        kind: 'done' as const,
        value: {
          manifest: manifest?.kind === 'manifest' ? manifest.manifest : null,
          chunks: parts.flatMap(part => part.kind === 'chunk' ? [part.chunk] : []),
        },
      };
    },
  };
  return fake;
}

async function deliverAll(fake: ReturnType<typeof transport>, sealed: SealedImportedHistory) {
  for (const chunk of sealed.chunks) {
    expect(await deliverImportedPart(fake, roomId, { kind: 'chunk', archiveId: 'archive-1', index: chunk.index, chunk })).toMatchObject({ kind: 'ok' });
  }
  expect(await deliverImportedPart(fake, roomId, { kind: 'manifest', archiveId: 'archive-1', manifest: sealed.manifest })).toMatchObject({ kind: 'ok' });
}

describe('imported history transport', () => {
  it('names each part deterministically', () => {
    expect(importedPartTxnId({ kind: 'chunk', archiveId: 'a', index: 3 })).toBe('a.chunk.3');
    expect(importedPartTxnId({ kind: 'manifest', archiveId: 'a' })).toBe('a.manifest');
  });

  it('reconciles a lost acknowledgement instead of sending the part again', async () => {
    const sealed = await seal();
    const fake = transport();
    const part: ImportedHistoryPart = { kind: 'manifest', archiveId: 'archive-1', manifest: sealed.manifest };
    fake.mode = 'lose_ack';
    expect(await deliverImportedPart(fake, roomId, part)).toEqual({ kind: 'outcome_unknown', operationId: 'archive-1.manifest' });
    fake.mode = 'ok';
    expect(await deliverImportedPart(fake, roomId, part)).toEqual({ kind: 'ok', value: { partId: 'part:archive-1.manifest', reconciled: true } });
    expect(fake.puts).toEqual(['archive-1.manifest']);
  });

  it('reports failures truthfully', async () => {
    const sealed = await seal();
    const fake = transport();
    const part: ImportedHistoryPart = { kind: 'chunk', archiveId: 'archive-1', index: 0, chunk: sealed.chunks[0]! };
    fake.mode = 'unavailable';
    expect(await deliverImportedPart(fake, roomId, part)).toEqual({ kind: 'unavailable', retryable: true });
    fake.mode = 'throw';
    expect(await deliverImportedPart(fake, roomId, part)).toEqual({ kind: 'outcome_unknown', operationId: 'archive-1.chunk.0' });
    fake.mode = 'ok';
    fake.lookups = 'unavailable';
    expect(await deliverImportedPart(fake, roomId, part)).toEqual({ kind: 'unavailable', retryable: true });
    expect(fake.puts).toEqual([]);
  });

  it('opens only the archive the transfer finished with, and pages it without writing', async () => {
    const sealed = await seal();
    const fake = transport();
    expect(await openImportedArchive(fake, { roomId, archiveId: 'archive-1', manifestDigest: 'sha256:x', limits }))
      .toEqual({ ok: false, reason: 'incomplete' });
    await deliverAll(fake, sealed);
    const digest = await digestImportedHistoryManifest(sealed.manifest);
    if (!digest.ok) throw new Error('digest');

    const other = await digestImportedHistoryManifest({ ...sealed.manifest, importedAt: '2026-09-25T14:00:00Z' });
    if (!other.ok) throw new Error('digest');
    expect(await openImportedArchive(fake, { roomId, archiveId: 'archive-1', manifestDigest: other.value, limits }))
      .toEqual({ ok: false, reason: 'manifest_mismatch' });

    const opened = await openImportedArchive(fake, { roomId, archiveId: 'archive-1', manifestDigest: digest.value, limits });
    if (!opened.ok) throw new Error(`open: ${JSON.stringify(opened)}`);
    expect(opened.view.records.map(record => record.body)).toEqual(['body 1\nnext', 'body 2\nnext', 'body 3\nnext']);
    const puts = fake.puts.length;
    const page = importedContextPage(opened.view, { cursor: null, limit: 10 }, limits);
    expect(page).toMatchObject({ ok: true, page: { nextCursor: '2' } });
    expect(fake.puts).toHaveLength(puts);
  });

  it('rejects a stored chunk whose body belongs to another record', async () => {
    const sealed = await seal();
    const fake = transport();
    await deliverAll(fake, sealed);
    const digest = await digestImportedHistoryManifest(sealed.manifest);
    if (!digest.ok) throw new Error('digest');
    const tampered = structuredClone(sealed.chunks[0]!);
    (tampered.records[0] as { body: string }).body = tampered.records[1]!.body;
    fake.stored.set('archive-1.chunk.0', { kind: 'chunk', archiveId: 'archive-1', index: 0, chunk: tampered });
    expect(await openImportedArchive(fake, { roomId, archiveId: 'archive-1', manifestDigest: digest.value, limits }))
      .toMatchObject({ ok: false, reason: 'invalid_archive', error: { code: 'mismatch' } });
  });
});
