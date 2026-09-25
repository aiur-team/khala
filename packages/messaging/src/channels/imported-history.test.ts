import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@khala/contracts/messaging/index';
import {
  type ImportedHistoryLimits, type ImportedHistoryRecordInput, type SealedImportedHistory, decodeImportedHistoryLimits,
  sealImportedHistory,
} from '@khala/contracts/messaging/imported-history';
import { type ImportedHistoryView, importedContextPage, projectImportedHistory } from './imported-history';

const limitsOf = (overrides: Partial<Record<keyof ImportedHistoryLimits, number>> = {}): ImportedHistoryLimits => {
  const decoded = decodeImportedHistoryLimits({
    maxBodyBytes: 64, maxAuthorLabelBytes: 64, maxRecordsPerChunk: 3, maxChunkBytes: 4096, maxChunks: 16,
    maxPageRecords: 4, maxPageBytes: 100, ...overrides,
  });
  if (!decoded.ok) throw new Error('limits must decode');
  return decoded.value;
};
const limits = limitsOf();

const record = (sequence: number, body: string): ImportedHistoryRecordInput => ({
  sourceRecordId: `msg-${sequence}`,
  sequence,
  originalAuthor: { label: 'Ada', kind: 'human' },
  originalSentAt: '2026-09-25T12:00:00Z',
  body,
});

async function seal(records: readonly ImportedHistoryRecordInput[]): Promise<SealedImportedHistory> {
  const sealed = await sealImportedHistory({
    archiveId: 'archive-1',
    source: { channelId: 'internal-channel-1', revision: 'rev-1' },
    importedBy: { ownerId: 'owner-1', participantId: '@ada:example.org' },
    importedAt: '2026-09-25T13:00:00Z',
    records,
  }, limits);
  if (!sealed.ok) throw new Error(`seal failed: ${sealed.error.path} ${sealed.error.code}`);
  return sealed.value;
}

async function view(records: readonly ImportedHistoryRecordInput[]): Promise<ImportedHistoryView> {
  const sealed = await seal(records);
  const projected = await projectImportedHistory(sealed.manifest, sealed.chunks, limits);
  if (!projected.ok) throw new Error(`projection failed: ${projected.error.path} ${projected.error.code}`);
  return projected.value;
}

const bodies = Array.from({ length: 10 }, (_, index) => `${index}:${'x'.repeat(index * 5)}`);
const records = bodies.map((body, index) => record(index * 2 + 1, body));

describe('imported history projection', () => {
  it('projects a verified archive as a frozen, source-ordered, imported-labelled view', async () => {
    const projected = await view(records);
    expect(projected).toMatchObject({
      kind: 'imported-history', archiveId: 'archive-1', importedBy: { ownerId: 'owner-1', participantId: '@ada:example.org' },
    });
    expect(projected.records.map(entry => entry.body)).toEqual(bodies);
    expect(projected.records.every(entry => entry.kind === 'imported')).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.records)).toBe(true);
    expect(Object.isFrozen(projected.records[0]!.originalAuthor)).toBe(true);
    expect(() => { (projected.records as unknown[]).push(null); }).toThrow(TypeError);
  });

  it('yields no view for a tampered or incomplete archive', async () => {
    const sealed = await seal(records);
    const tampered = structuredClone(sealed.chunks) as unknown as { records: { body: string }[] }[];
    tampered[2]!.records[0]!.body = 'forged';
    expect(await projectImportedHistory(sealed.manifest, tampered, limits))
      .toEqual({ ok: false, error: { path: 'chunks[2].records[0].recordDigest', code: 'mismatch' } });
    expect(await projectImportedHistory(sealed.manifest, sealed.chunks.slice(1), limits))
      .toEqual({ ok: false, error: { path: 'chunks', code: 'mismatch' } });
  });

  it('is not assignable to a timeline item', async () => {
    const projected = await view(records.slice(0, 1));
    // @ts-expect-error imported records are not timeline entries
    const asItem: TimelineItem = projected.records[0]!;
    expect(asItem).toBeDefined();
  });
});

describe('agent context pages', () => {
  it('pages every record exactly once within the record and byte bounds', async () => {
    const projected = await view(records);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = importedContextPage(projected, { cursor, limit: 10 }, limits);
      if (!result.ok) throw new Error('page refused');
      const { page } = result;
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.records.length).toBeLessThanOrEqual(limits.maxPageRecords);
      expect(page.records.reduce((sum, entry) => sum + new TextEncoder().encode(entry.body).byteLength, 0))
        .toBeLessThanOrEqual(limits.maxPageBytes);
      seen.push(...page.records.map(entry => entry.body));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 20);
    expect(seen).toEqual(bodies);
    expect(pages).toBeGreaterThan(2);
  });

  it('honours a smaller caller limit and ends with a null cursor', async () => {
    const projected = await view(records.slice(0, 3));
    const first = importedContextPage(projected, { cursor: null, limit: 2 }, limits);
    expect(first).toMatchObject({ ok: true, page: { nextCursor: '3' } });
    if (!first.ok) return;
    expect(first.page.records.map(entry => entry.sequence)).toEqual([1, 3]);
    expect(importedContextPage(projected, { cursor: first.page.nextCursor, limit: 2 }, limits))
      .toMatchObject({ ok: true, page: { nextCursor: null, records: [{ sequence: 5 }] } });
    expect(importedContextPage(projected, { cursor: '5', limit: 2 }, limits))
      .toEqual({ ok: true, page: { archiveId: 'archive-1', records: [], nextCursor: null } });
  });

  it('always returns one maximum-sized body even when it alone fills the page', async () => {
    const tight = limitsOf({ maxPageBytes: 64 });
    const projected = await view([record(1, 'y'.repeat(64)), record(2, 'z')]);
    const result = importedContextPage(projected, { cursor: null, limit: 10 }, tight);
    expect(result).toMatchObject({ ok: true, page: { nextCursor: '1' } });
  });

  it('refuses malformed cursors and limits', async () => {
    const projected = await view(records.slice(0, 2));
    for (const request of [
      { cursor: '-1', limit: 1 }, { cursor: '01', limit: 1 }, { cursor: 'abc', limit: 1 }, { cursor: '1e3', limit: 1 },
      { cursor: '99999999999999999999', limit: 1 }, { cursor: null, limit: 0 }, { cursor: null, limit: 1.5 },
    ]) {
      expect(importedContextPage(projected, request, limits)).toEqual({ ok: false, reason: 'invalid_request' });
    }
  });
});
