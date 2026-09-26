import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import vectors from '../../fixtures/messaging/imported-history.json';
import { decodeEventRef as decodeDeliveryEventRef, decodeEventSelection } from '../delivery/events';
import { decodeApprovalCommand } from '../delivery/commands';
import { decodeDeliveryLimits } from '../delivery/decode';
import { decodeContentLimits } from './decode';
import { type EventRef, decodeEventRef, decodeTimelineItem } from './events';
import {
  type ImportedHistoryChunk, type ImportedHistoryLimits, type ImportedHistoryManifest, type ImportedHistoryRecord,
  type ImportedHistoryRecordInput, type SealedImportedHistory, decodeImportedHistoryChunk, decodeImportedHistoryLimits,
  digestImportedHistoryManifest, encodeImportedHistoryManifest,
  decodeImportedHistoryManifest, encodeImportedHistoryChunk, encodeImportedRecord, openImportedHistory, sealImportedHistory,
} from './imported-history';

const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function limitsOf(overrides: Partial<Record<keyof ImportedHistoryLimits, number>> = {}): ImportedHistoryLimits {
  const decoded = decodeImportedHistoryLimits({ ...vectors.limits, ...overrides });
  if (!decoded.ok) throw new Error(`limits must decode: ${decoded.error.path} ${decoded.error.code}`);
  return decoded.value;
}

const limits = limitsOf();
const fixtureRecord = vectors.record as ImportedHistoryRecordInput;

const record = (sequence: number, body: string, overrides: Partial<ImportedHistoryRecordInput> = {}): ImportedHistoryRecordInput => ({
  sourceRecordId: `msg-${sequence}`,
  sequence,
  originalAuthor: { label: sequence % 2 === 0 ? 'Ada' : 'reviewer-agent', kind: sequence % 2 === 0 ? 'human' : 'agent' },
  originalSentAt: '2026-09-25T12:00:00Z',
  body,
  ...overrides,
});

const archive = (records: readonly ImportedHistoryRecordInput[]) => ({ ...vectors.archive, records });

async function seal(records: readonly ImportedHistoryRecordInput[], at = limits): Promise<SealedImportedHistory> {
  const sealed = await sealImportedHistory(archive(records), at);
  if (!sealed.ok) throw new Error(`seal failed: ${sealed.error.path} ${sealed.error.code}`);
  return sealed.value;
}

/** Re-digests a tampered chunk honestly and lists it in the manifest, so only record-level checks remain. */
function reseal(sealed: SealedImportedHistory, index: number, chunk: ImportedHistoryChunk): SealedImportedHistory {
  const chunkDigest = sha256(encodeImportedHistoryChunk(chunk));
  const manifest: ImportedHistoryManifest = {
    ...sealed.manifest,
    chunks: sealed.manifest.chunks.map(entry => (entry.index === index ? { ...entry, chunkDigest } : entry)),
  };
  return { manifest, chunks: sealed.chunks.map(existing => (existing.index === index ? { ...chunk, chunkDigest } : existing)) };
}

const unicodeBodies = [
  'plain ascii',
  'line one\nline two\r\nline three\rtabs\there',
  'emoji 👩🏽‍💻 and flags 🇯🇵, ZWJ‍ and ZWNJ‌ kept',
  'CJK 漢字かなカナ 한국어, RTL עברית العربية',
  'separators   and  , DEL \u007f, <b>&amp;</b> "quoted" \\ backslash',
  'control \u0001\u001f escaped, NFC é vs NFD é',
  '',
];

describe('imported history limits', () => {
  it('decodes positive limits and refuses zero, unknown fields and a page smaller than one body', () => {
    expect(limits.maxChunkBytes).toBe(vectors.limits.maxChunkBytes);
    expect(decodeImportedHistoryLimits({ ...vectors.limits, maxChunks: 0 })).toEqual({ ok: false, error: { path: 'maxChunks', code: 'invalid_value' } });
    expect(decodeImportedHistoryLimits({ ...vectors.limits, extra: 1 })).toMatchObject({ ok: false, error: { code: 'unknown_field' } });
    expect(decodeImportedHistoryLimits({ ...vectors.limits, maxPageBytes: vectors.limits.maxBodyBytes - 1 }))
      .toEqual({ ok: false, error: { path: 'maxPageBytes', code: 'invalid_limits' } });
  });
});

describe('deterministic encoding', () => {
  it('pins the record and chunk digests with an independent SHA-256', async () => {
    const sealed = await seal([fixtureRecord]);
    const [chunk] = sealed.chunks;
    const recordBytes = encodeImportedRecord(vectors.archive.source.channelId, fixtureRecord);
    expect(Buffer.from(recordBytes).toString('utf8')).toBe(vectors.encoding.recordUtf8);
    expect(chunk!.records[0]!.recordDigest).toBe(sha256(recordBytes));
    expect(chunk!.records[0]!.recordDigest).toBe(vectors.encoding.recordDigest);
    expect(chunk!.chunkDigest).toBe(sha256(Buffer.from(vectors.encoding.chunkUtf8, 'utf8')));
    expect(chunk!.chunkDigest).toBe(vectors.encoding.chunkDigest);
  });

  it('digests the manifest over its canonical encoding, and any listed change moves the digest', async () => {
    const sealed = await seal([fixtureRecord]);
    const digest = await digestImportedHistoryManifest(sealed.manifest);
    expect(digest).toEqual({ ok: true, value: sha256(encodeImportedHistoryManifest(sealed.manifest)) });
    expect(Buffer.from(encodeImportedHistoryManifest(sealed.manifest)).toString('utf8')).toBe(JSON.stringify([
      'khala.imported-history.manifest.v1', 'archive-1', 'internal-channel-1', 'rev-7', 'owner-1', '@ada:example.org',
      '2026-09-25T13:00:00Z', 1, [[0, 1, 1, 1, vectors.encoding.chunkDigest]],
    ]));
    const changed = [
      { ...sealed.manifest, source: { ...sealed.manifest.source, revision: 'rev-8' } },
      { ...sealed.manifest, importedBy: { ...sealed.manifest.importedBy, participantId: '@eve:example.org' } },
      { ...sealed.manifest, chunks: [{ ...sealed.manifest.chunks[0]!, chunkDigest: vectors.encoding.recordDigest }] },
    ] as ImportedHistoryManifest[];
    for (const manifest of changed) expect(await digestImportedHistoryManifest(manifest)).not.toEqual(digest);
  });

  it('seals the same input to the same bytes every time', async () => {
    const records = unicodeBodies.map((body, index) => record(index + 1, body));
    const first = await seal(records);
    const second = await seal(clone(records));
    expect(second).toEqual(first);
    expect(second.chunks.map(chunk => Buffer.from(encodeImportedHistoryChunk(chunk)).toString('hex')))
      .toEqual(first.chunks.map(chunk => Buffer.from(encodeImportedHistoryChunk(chunk)).toString('hex')));
  });

  it('round-trips Unicode and newlines exactly through JSON transport', async () => {
    const records = unicodeBodies.map((body, index) => record(index + 1, body));
    const sealed = clone(await seal(records));
    const opened = await openImportedHistory(sealed.manifest, sealed.chunks, limits);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.records).toEqual(records.map((input, index) => ({
      v: 1, kind: 'imported', ...input, recordDigest: opened.value.records[index]!.recordDigest,
    })));
    expect(opened.value.records.map(entry => entry.body)).toEqual(unicodeBodies);
  });
});

describe('bounds', () => {
  it('accepts a body at exactly maxBodyBytes and refuses one byte more', async () => {
    const exact = 'é'.repeat(vectors.limits.maxBodyBytes / 2);
    const sealed = await seal([record(1, exact)]);
    expect(sealed.chunks[0]!.records[0]!.body).toBe(exact);
    expect(await sealImportedHistory(archive([record(1, `${exact}x`)]), limits))
      .toEqual({ ok: false, error: { path: 'records[0].body', code: 'too_long' } });
  });

  it('packs chunks up to exactly maxChunkBytes and maxRecordsPerChunk', async () => {
    const records = Array.from({ length: 9 }, (_, index) => record(index * 3, 'x'.repeat(20 + index)));
    const probe = await seal(records.slice(0, 2), limitsOf({ maxChunkBytes: 100_000 }));
    const twoRecordBytes = encodeImportedHistoryChunk(probe.chunks[0]!).byteLength;
    const exact = limitsOf({ maxChunkBytes: twoRecordBytes });
    const packed = await seal(records.slice(0, 2), exact);
    expect(packed.chunks).toHaveLength(1);
    expect(encodeImportedHistoryChunk(packed.chunks[0]!).byteLength).toBe(twoRecordBytes);
    expect((await seal(records.slice(0, 2), limitsOf({ maxChunkBytes: twoRecordBytes - 1 }))).chunks).toHaveLength(2);

    const byCount = await seal(records, limitsOf({ maxRecordsPerChunk: 4 }));
    expect(byCount.chunks.map(chunk => chunk.records.length)).toEqual([4, 4, 1]);
    expect(byCount.manifest.recordCount).toBe(9);
    for (const chunk of byCount.chunks) expect(encodeImportedHistoryChunk(chunk).byteLength).toBeLessThanOrEqual(limits.maxChunkBytes);
  });

  it('refuses a record that cannot fit any chunk and an archive needing more than maxChunks', async () => {
    expect(await sealImportedHistory(archive([record(1, 'x'.repeat(200))]), limitsOf({ maxChunkBytes: 150 })))
      .toEqual({ ok: false, error: { path: 'records[0]', code: 'too_long' } });
    const three = [record(1, 'a'), record(2, 'b'), record(3, 'c')];
    expect(await sealImportedHistory(archive(three), limitsOf({ maxRecordsPerChunk: 1, maxChunks: 2 })))
      .toEqual({ ok: false, error: { path: 'records', code: 'too_long' } });
  });

  it('refuses out-of-order and duplicate source records', async () => {
    expect(await sealImportedHistory(archive([record(2, 'a'), record(2, 'b', { sourceRecordId: 'other' })]), limits))
      .toEqual({ ok: false, error: { path: 'records[1].sequence', code: 'invalid_value' } });
    expect(await sealImportedHistory(archive([record(1, 'a'), record(2, 'b', { sourceRecordId: 'msg-1' })]), limits))
      .toEqual({ ok: false, error: { path: 'records[1].sourceRecordId', code: 'duplicate' } });
  });

  it('seals and opens an empty archive', async () => {
    const sealed = await seal([]);
    expect(sealed.manifest).toMatchObject({ recordCount: 0, chunks: [] });
    expect(await openImportedHistory(sealed.manifest, [], limits)).toMatchObject({ ok: true, value: { records: [] } });
  });
});

describe('digest verification', () => {
  const records = Array.from({ length: 6 }, (_, index) => record(index + 1, `message ${index + 1}`));
  const tight = limitsOf({ maxRecordsPerChunk: 2 });

  it('opens an untouched archive', async () => {
    const sealed = await seal(records, tight);
    expect(sealed.chunks).toHaveLength(3);
    expect(await openImportedHistory(sealed.manifest, sealed.chunks, tight)).toMatchObject({ ok: true });
  });

  it('refuses reordered, dropped, extra and foreign chunks', async () => {
    const sealed = await seal(records, tight);
    const [a, b, c] = sealed.chunks;
    expect(await openImportedHistory(sealed.manifest, [b, a, c], tight))
      .toEqual({ ok: false, error: { path: 'chunks[0].index', code: 'mismatch' } });
    expect(await openImportedHistory(sealed.manifest, [a, c], tight)).toEqual({ ok: false, error: { path: 'chunks', code: 'mismatch' } });
    expect(await openImportedHistory(sealed.manifest, [a, b, c, c], tight)).toEqual({ ok: false, error: { path: 'chunks', code: 'mismatch' } });
    // Dropping a chunk and relabelling the rest still cannot match the listed digests.
    expect(await openImportedHistory(sealed.manifest, [a, { ...c!, index: 1 }, c], tight))
      .toMatchObject({ ok: false, error: { path: 'chunks[1].records', code: 'mismatch' } });
    const foreign = await seal(records, tight);
    const other = { ...foreign.chunks[1]!, archiveId: 'archive-other' };
    expect(await openImportedHistory(sealed.manifest, [a, other, c], tight))
      .toEqual({ ok: false, error: { path: 'chunks[1].archiveId', code: 'mismatch' } });
  });

  it('refuses an altered body, an altered attribution and a re-digested chunk the manifest does not list', async () => {
    const sealed = await seal(records, tight);
    const altered = clone(sealed.chunks);
    (altered[1]!.records[0] as { body: string }).body = 'forged';
    expect(await openImportedHistory(sealed.manifest, altered, tight))
      .toEqual({ ok: false, error: { path: 'chunks[1].records[0].recordDigest', code: 'mismatch' } });

    const relabelled = clone(sealed.chunks);
    (relabelled[0]!.records[1] as { originalAuthor: { label: string } }).originalAuthor.label = 'Someone Else';
    expect(await openImportedHistory(sealed.manifest, relabelled, tight))
      .toEqual({ ok: false, error: { path: 'chunks[0].records[1].recordDigest', code: 'mismatch' } });

    // A consistently re-digested record and chunk still differs from the manifest's listed digest.
    const forgedRecord = { ...sealed.chunks[1]!.records[0]!, body: 'forged' };
    const redigested = { ...forgedRecord, recordDigest: sha256(encodeImportedRecord(sealed.manifest.source.channelId, forgedRecord)) };
    const chunk = { ...sealed.chunks[1]!, records: [redigested, sealed.chunks[1]!.records[1]!] };
    const withChunkDigest = { ...chunk, chunkDigest: sha256(encodeImportedHistoryChunk(chunk)) };
    expect(await openImportedHistory(sealed.manifest, [sealed.chunks[0], withChunkDigest, sealed.chunks[2]], tight))
      .toEqual({ ok: false, error: { path: 'chunks[1].chunkDigest', code: 'mismatch' } });
  });

  it('refuses records moved to another source channel', async () => {
    const sealed = await seal(records, tight);
    const moved = { ...sealed.manifest, source: { ...sealed.manifest.source, channelId: 'internal-other' } };
    expect(await openImportedHistory(moved, sealed.chunks, tight))
      .toEqual({ ok: false, error: { path: 'chunks[0].records[0].recordDigest', code: 'mismatch' } });
  });

  // Wrong implementation caught: accepting a body whose digest belongs to another source record.
  it('refuses a body carried with the digest of another source record', async () => {
    const pair = await seal([record(1, 'approved by Ada'), record(2, 'rejected by Ada')]);
    const [first, second] = pair.chunks[0]!.records;
    const swapped: ImportedHistoryRecord = { ...second!, body: first!.body, recordDigest: first!.recordDigest };
    const tampered = reseal(pair, 0, { ...pair.chunks[0]!, records: [first!, swapped] });
    expect(await openImportedHistory(tampered.manifest, tampered.chunks, limits))
      .toEqual({ ok: false, error: { path: 'chunks[0].records[1].recordDigest', code: 'mismatch' } });
    expect(await decodeImportedHistoryChunk(tampered.chunks[0], tampered.manifest, limits))
      .toEqual({ ok: false, error: { path: 'records[1].recordDigest', code: 'mismatch' } });
  });

  it('refuses a manifest whose counts or order do not add up', async () => {
    const sealed = await seal(records, tight);
    expect(decodeImportedHistoryManifest({ ...sealed.manifest, recordCount: 5 }, tight))
      .toEqual({ ok: false, error: { path: 'recordCount', code: 'mismatch' } });
    const [a, b, c] = sealed.manifest.chunks;
    expect(decodeImportedHistoryManifest({ ...sealed.manifest, chunks: [b, a, c] }, tight))
      .toEqual({ ok: false, error: { path: 'chunks[0].index', code: 'mismatch' } });
    expect(decodeImportedHistoryManifest({ ...sealed.manifest, chunks: [a, { ...b!, firstSequence: 2 }, c] }, tight))
      .toMatchObject({ ok: false, error: { path: 'chunks[1].firstSequence', code: 'invalid_value' } });
    expect(decodeImportedHistoryManifest(sealed.manifest, limitsOf({ maxRecordsPerChunk: 2, maxChunks: 2 })))
      .toEqual({ ok: false, error: { path: 'chunks', code: 'too_long' } });
  });
});

describe('strict decoding', () => {
  it('refuses unknown versions, kinds and fields', async () => {
    const sealed = clone(await seal([record(1, 'a')]));
    const chunk = sealed.chunks[0]!;
    const cases: [unknown, string, string][] = [
      [{ ...chunk, v: 2 }, 'v', 'unsupported_version'],
      [{ ...chunk, extra: true }, 'extra', 'unknown_field'],
      [{ ...chunk, records: [{ ...chunk.records[0], v: 2 }] }, 'records[0].v', 'unsupported_version'],
      [{ ...chunk, records: [{ ...chunk.records[0], kind: 'text' }] }, 'records[0].kind', 'invalid_value'],
      [{ ...chunk, records: [{ ...chunk.records[0], eventId: '$event' }] }, 'records[0].eventId', 'unknown_field'],
      [{ ...chunk, records: [{ ...chunk.records[0], originalAuthor: { label: 'Ada‮', kind: 'human' } }] }, 'records[0].originalAuthor.label', 'control_character'],
      [{ ...chunk, records: [{ ...chunk.records[0], originalAuthor: { label: 'Ada', kind: 'system' } }] }, 'records[0].originalAuthor.kind', 'invalid_value'],
      [{ ...chunk, records: [{ ...chunk.records[0], recordDigest: 'sha256:ABC' }] }, 'records[0].recordDigest', 'invalid_value'],
    ];
    for (const [input, path, code] of cases) {
      expect(await decodeImportedHistoryChunk(input, sealed.manifest, limits)).toEqual({ ok: false, error: { path, code } });
    }
    expect(decodeImportedHistoryManifest({ ...sealed.manifest, v: 2 }, limits)).toEqual({ ok: false, error: { path: 'v', code: 'unsupported_version' } });
    expect(decodeImportedHistoryManifest({ ...sealed.manifest, importedBy: { ...sealed.manifest.importedBy, deviceId: 'd' } }, limits))
      .toEqual({ ok: false, error: { path: 'importedBy.deviceId', code: 'unknown_field' } });
  });

  it('reports a missing Web Crypto as digest_unavailable, never as tampering', async () => {
    const sealed = await seal([record(1, 'a')]);
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(await decodeImportedHistoryChunk(sealed.chunks[0], sealed.manifest, limits))
        .toEqual({ ok: false, error: { path: '', code: 'digest_unavailable' } });
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});

describe('imported records are not native events', () => {
  const contentLimits = (() => {
    const decoded = decodeContentLimits(intro.limits);
    if (!decoded.ok) throw new Error('fixture limits must decode');
    return decoded.value;
  })();
  const deliveryLimits = (() => {
    const decoded = decodeDeliveryLimits({ maxSelectionEvents: 10, maxPayloadBytes: 65_536 });
    if (!decoded.ok) throw new Error('delivery limits must decode');
    return decoded.value;
  })();

  it('cannot satisfy EventRef or enter timeline, selection or approval decoders', async () => {
    const sealed = clone(await seal([record(1, 'approve release 42')]));
    const imported = sealed.chunks[0]!.records[0]!;
    expect(decodeEventRef(imported).ok).toBe(false);
    expect(decodeDeliveryEventRef(imported).ok).toBe(false);
    expect(decodeEventSelection([imported], deliveryLimits).ok).toBe(false);
    expect(decodeApprovalCommand({
      v: 1, commandId: 'command-1', roomId: '!room:example.org', bindingId: 'binding-1', expectedPolicyVersion: 1,
      expectedBindingGeneration: 1, selection: [imported], issuedAt: '2026-09-25T12:00:00Z',
    }, deliveryLimits)).toMatchObject({ ok: false, field: 'selection[0].kind' });
    // The native item decodes; swapping in the imported record as its reference does not.
    expect((await decodeTimelineItem(intro.timelineItem, contentLimits)).ok).toBe(true);
    const timelineItem = { ...intro.timelineItem, ref: imported, content: { v: 1, kind: 'text', body: imported.body } };
    expect(await decodeTimelineItem(timelineItem, contentLimits)).toEqual({ ok: false, error: { path: 'ref.kind', code: 'unknown_field' } });

    // @ts-expect-error an imported record has none of EventRef's identity fields
    const asRef: EventRef = imported;
    expect(asRef).toBeDefined();
  });

  it('attributes the import to the signed-in actor and keeps the original author as a label', async () => {
    const sealed = await seal([record(2, 'hello')]);
    expect(sealed.manifest.importedBy).toEqual(vectors.archive.importedBy);
    const imported = sealed.chunks[0]!.records[0]!;
    expect(imported.originalAuthor).toEqual({ label: 'Ada', kind: 'human' });
    for (const field of ['authorParticipantId', 'authorDeviceId', 'participantId', 'ownerId', 'eventId', 'contentDigest']) {
      expect(Object.keys(imported)).not.toContain(field);
    }
  });
});
