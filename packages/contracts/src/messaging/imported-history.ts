// Imported history: a versioned, digest-bound archive of an internal channel's
// messages, carried through the external channel's end-to-end encryption and shown
// there as read-only provenance. An imported record is never a native event. It has
// no `EventRef`, so it cannot reach approval, release, delivery or receipt APIs, and
// its original author is a display label, not an external participant.

import {
  type Decoded, type Reader, DecodeFailure, array, decodeWith, displayText, elementPath, fail, identifier, literal,
  object, safeInteger, text, utcTimestamp, version,
} from './decode';
import { type OwnerId, type ParticipantId, readId } from './ids';

/** Domain separator of the version 1 record digest encoding. */
export const IMPORTED_RECORD_ENCODING_V1 = 'khala.imported-history.record.v1';
/** Domain separator of the version 1 chunk encoding. */
export const IMPORTED_CHUNK_ENCODING_V1 = 'khala.imported-history.chunk.v1';
/** Domain separator of the version 1 manifest digest encoding. */
export const IMPORTED_MANIFEST_ENCODING_V1 = 'khala.imported-history.manifest.v1';

/**
 * Bounds of one archive. `maxChunkBytes` bounds `encodeImportedHistoryChunk`; the
 * page limits bound the context an agent reads at once, counted in body bytes. The
 * brand means a value only comes from `decodeImportedHistoryLimits`.
 */
export type ImportedHistoryLimits = Readonly<{
  maxBodyBytes: number;
  maxAuthorLabelBytes: number;
  maxRecordsPerChunk: number;
  maxChunkBytes: number;
  maxChunks: number;
  maxPageRecords: number;
  maxPageBytes: number;
}> & { readonly __khala: 'ImportedHistoryLimits' };

const LIMIT_KEYS = [
  'maxBodyBytes', 'maxAuthorLabelBytes', 'maxRecordsPerChunk', 'maxChunkBytes', 'maxChunks', 'maxPageRecords',
  'maxPageBytes',
] as const;

/** Every limit is a positive safe integer, and one maximum-sized body always fits one page. */
export function decodeImportedHistoryLimits(input: unknown): Decoded<ImportedHistoryLimits> {
  return decodeWith(() => {
    const r = object(input, '', LIMIT_KEYS);
    const limits = Object.fromEntries(LIMIT_KEYS.map(key => {
      const value = safeInteger(r.field(key), r.at(key));
      if (value === 0) fail(r.at(key), 'invalid_value');
      return [key, value];
    })) as unknown as ImportedHistoryLimits;
    if (limits.maxPageBytes < limits.maxBodyBytes) fail(r.at('maxPageBytes'), 'invalid_limits');
    return limits;
  });
}

/** The internal channel and the snapshot revision the archive was taken from. */
export type ImportedHistorySource = Readonly<{ channelId: string; revision: string }>;

/** The signed-in owner's participant that performed the import: the only external author. */
export type ImportedHistoryActor = Readonly<{ ownerId: OwnerId; participantId: ParticipantId }>;

/** How the source channel labelled a message's author. Display provenance only. */
export type ImportedOriginalAuthor = Readonly<{ label: string; kind: 'human' | 'agent' }>;

/** A source message before sealing. */
export type ImportedHistoryRecordInput = Readonly<{
  sourceRecordId: string;
  /** Source order. Strictly increasing across the archive; gaps are allowed. */
  sequence: number;
  originalAuthor: ImportedOriginalAuthor;
  /** UTC RFC 3339, as the source recorded it. */
  originalSentAt: string;
  /** Retained exactly: never Unicode- or newline-normalised. */
  body: string;
}>;

/**
 * One imported message. `kind: 'imported'` and the absence of every `EventRef` field
 * keep it structurally apart from native events. `recordDigest` binds the body to its
 * source channel, source record, position and original attribution.
 */
export type ImportedHistoryRecord = Readonly<{ v: 1; kind: 'imported'; recordDigest: string } & ImportedHistoryRecordInput>;

export type ImportedHistoryChunkEntry = Readonly<{
  index: number;
  recordCount: number;
  firstSequence: number;
  lastSequence: number;
  chunkDigest: string;
}>;

/** Lists every chunk in order, so a dropped, reordered or altered chunk is detectable. */
export type ImportedHistoryManifest = Readonly<{
  v: 1;
  archiveId: string;
  source: ImportedHistorySource;
  importedBy: ImportedHistoryActor;
  /** UTC RFC 3339. */
  importedAt: string;
  recordCount: number;
  chunks: readonly ImportedHistoryChunkEntry[];
}>;

export type ImportedHistoryChunk = Readonly<{
  v: 1;
  archiveId: string;
  index: number;
  records: readonly ImportedHistoryRecord[];
  chunkDigest: string;
}>;

/** A manifest and records whose every digest, count and order has been recomputed. */
export type VerifiedImportedHistory = Readonly<{
  manifest: ImportedHistoryManifest;
  records: readonly ImportedHistoryRecord[];
}>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/**
 * Record digest preimage: UTF-8 of the compact JSON array
 * `["khala.imported-history.record.v1",channelId,sourceRecordId,sequence,authorLabel,authorKind,sentAt,body]`,
 * escaped exactly as `encodeMessageContent`. Positional, so no key ordering applies.
 */
export function encodeImportedRecord(channelId: string, record: ImportedHistoryRecordInput): Uint8Array {
  return encoder.encode(JSON.stringify([
    IMPORTED_RECORD_ENCODING_V1, channelId, record.sourceRecordId, record.sequence, record.originalAuthor.label,
    record.originalAuthor.kind, record.originalSentAt, record.body,
  ]));
}

function chunkRecordTuple(record: ImportedHistoryRecord): unknown[] {
  return [
    record.sourceRecordId, record.sequence, record.originalAuthor.label, record.originalAuthor.kind,
    record.originalSentAt, record.body, record.recordDigest,
  ];
}

/**
 * Chunk encoding: UTF-8 of `["khala.imported-history.chunk.v1",archiveId,index,[[sourceRecordId,
 * sequence,authorLabel,authorKind,sentAt,body,recordDigest],...]]`. It is both the
 * `chunkDigest` preimage and the size `maxChunkBytes` bounds.
 */
export function encodeImportedHistoryChunk(chunk: Pick<ImportedHistoryChunk, 'archiveId' | 'index' | 'records'>): Uint8Array {
  return encoder.encode(JSON.stringify([IMPORTED_CHUNK_ENCODING_V1, chunk.archiveId, chunk.index, chunk.records.map(chunkRecordTuple)]));
}

/**
 * Manifest encoding: UTF-8 of `["khala.imported-history.manifest.v1",archiveId,channelId,revision,ownerId,
 * participantId,importedAt,recordCount,[[index,recordCount,firstSequence,lastSequence,chunkDigest],...]]`.
 * Its digest names one exact archive, for example as a transfer's `manifestDigest`.
 */
export function encodeImportedHistoryManifest(manifest: ImportedHistoryManifest): Uint8Array {
  return encoder.encode(JSON.stringify([
    IMPORTED_MANIFEST_ENCODING_V1, manifest.archiveId, manifest.source.channelId, manifest.source.revision,
    manifest.importedBy.ownerId, manifest.importedBy.participantId, manifest.importedAt, manifest.recordCount,
    manifest.chunks.map(entry => [entry.index, entry.recordCount, entry.firstSequence, entry.lastSequence, entry.chunkDigest]),
  ]));
}

/** `sha256:<hex>` over `encodeImportedHistoryManifest`. Only `digest_unavailable` can fail it. */
export async function digestImportedHistoryManifest(manifest: ImportedHistoryManifest): Promise<Decoded<string>> {
  return decodeAsync(() => sha256(encodeImportedHistoryManifest(manifest)));
}

class DigestUnavailable extends Error {}

async function sha256(bytes: Uint8Array): Promise<string> {
  let digest: Uint8Array;
  try {
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  } catch {
    throw new DigestUnavailable();
  }
  return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** `decodeWith` for readers that digest; a missing Web Crypto becomes `digest_unavailable`, never a content failure. */
async function decodeAsync<T>(read: () => Promise<T>): Promise<Decoded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof DigestUnavailable) return { ok: false, error: { path: '', code: 'digest_unavailable' } };
    if (error instanceof DecodeFailure) return { ok: false, error: { path: error.path, code: error.code } };
    throw error;
  }
}

function digestField(input: unknown, path: string): string {
  const value = identifier(input, path);
  if (!DIGEST.test(value)) fail(path, 'invalid_value');
  return value;
}

function readSource(input: unknown, path: string): ImportedHistorySource {
  const r = object(input, path, ['channelId', 'revision']);
  return { channelId: identifier(r.field('channelId'), r.at('channelId')), revision: identifier(r.field('revision'), r.at('revision')) };
}

function readActor(input: unknown, path: string): ImportedHistoryActor {
  const r = object(input, path, ['ownerId', 'participantId']);
  return {
    ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
    participantId: readId<'ParticipantId'>(r.field('participantId'), r.at('participantId')),
  };
}

const RECORD_INPUT_KEYS = ['sourceRecordId', 'sequence', 'originalAuthor', 'originalSentAt', 'body'];

function readRecordFields(r: Reader, limits: ImportedHistoryLimits): ImportedHistoryRecordInput {
  const author = object(r.field('originalAuthor'), r.at('originalAuthor'), ['label', 'kind']);
  const label = displayText(author.field('label'), author.at('label'), limits.maxAuthorLabelBytes);
  if (label.length === 0) fail(author.at('label'), 'empty');
  return {
    sourceRecordId: identifier(r.field('sourceRecordId'), r.at('sourceRecordId')),
    sequence: safeInteger(r.field('sequence'), r.at('sequence')),
    originalAuthor: { label, kind: literal(author.field('kind'), author.at('kind'), ['human', 'agent']) },
    originalSentAt: utcTimestamp(r.field('originalSentAt'), r.at('originalSentAt')),
    body: text(r.field('body'), r.at('body'), limits.maxBodyBytes),
  };
}

function readRecord(input: unknown, path: string, limits: ImportedHistoryLimits): ImportedHistoryRecord {
  const r = object(input, path, ['v', 'kind', ...RECORD_INPUT_KEYS, 'recordDigest']);
  return {
    v: version(r.field('v'), r.at('v')),
    kind: literal(r.field('kind'), r.at('kind'), ['imported']),
    ...readRecordFields(r, limits),
    recordDigest: digestField(r.field('recordDigest'), r.at('recordDigest')),
  };
}

function readChunkEntry(input: unknown, path: string): ImportedHistoryChunkEntry {
  const r = object(input, path, ['index', 'recordCount', 'firstSequence', 'lastSequence', 'chunkDigest']);
  const entry = {
    index: safeInteger(r.field('index'), r.at('index')),
    recordCount: safeInteger(r.field('recordCount'), r.at('recordCount')),
    firstSequence: safeInteger(r.field('firstSequence'), r.at('firstSequence')),
    lastSequence: safeInteger(r.field('lastSequence'), r.at('lastSequence')),
    chunkDigest: digestField(r.field('chunkDigest'), r.at('chunkDigest')),
  };
  if (entry.recordCount === 0) fail(r.at('recordCount'), 'invalid_value');
  if (entry.lastSequence < entry.firstSequence) fail(r.at('lastSequence'), 'invalid_value');
  // Strictly increasing sequences cannot fit more records than the range holds.
  if (entry.recordCount > entry.lastSequence - entry.firstSequence + 1) fail(r.at('recordCount'), 'invalid_value');
  return entry;
}

/**
 * Structural manifest read. Chunks are indexed `0..n-1` in order, their sequence
 * ranges strictly increase, and `recordCount` is their sum. Chunk bytes are checked
 * against the listed digests by `decodeImportedHistoryChunk`.
 */
export function decodeImportedHistoryManifest(input: unknown, limits: ImportedHistoryLimits): Decoded<ImportedHistoryManifest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'archiveId', 'source', 'importedBy', 'importedAt', 'recordCount', 'chunks']);
    const values = array(r.field('chunks'), r.at('chunks'));
    if (values.length > limits.maxChunks) fail(r.at('chunks'), 'too_long');
    const chunks: ImportedHistoryChunkEntry[] = [];
    for (const [index, value] of values.entries()) {
      const at = elementPath(r.at('chunks'), index);
      const entry = readChunkEntry(value, at);
      if (entry.index !== index) fail(`${at}.index`, 'mismatch');
      if (entry.recordCount > limits.maxRecordsPerChunk) fail(`${at}.recordCount`, 'too_long');
      const previous = chunks.at(-1);
      if (previous !== undefined && entry.firstSequence <= previous.lastSequence) fail(`${at}.firstSequence`, 'invalid_value');
      chunks.push(entry);
    }
    const manifest: ImportedHistoryManifest = {
      v: version(r.field('v'), r.at('v')),
      archiveId: identifier(r.field('archiveId'), r.at('archiveId')),
      source: readSource(r.field('source'), r.at('source')),
      importedBy: readActor(r.field('importedBy'), r.at('importedBy')),
      importedAt: utcTimestamp(r.field('importedAt'), r.at('importedAt')),
      recordCount: safeInteger(r.field('recordCount'), r.at('recordCount')),
      chunks,
    };
    if (manifest.recordCount !== chunks.reduce((sum, entry) => sum + entry.recordCount, 0)) fail(r.at('recordCount'), 'mismatch');
    return manifest;
  });
}

/**
 * Decodes the chunk the manifest lists at `chunk.index` and proves it is exactly that
 * chunk: every record digest is recomputed against the manifest's source channel, the
 * chunk digest is recomputed over the canonical encoding, and count, sequence range,
 * order and byte size all match. Structural success alone is never enough.
 */
export async function decodeImportedHistoryChunk(
  input: unknown, manifest: ImportedHistoryManifest, limits: ImportedHistoryLimits,
): Promise<Decoded<ImportedHistoryChunk>> {
  return decodeAsync(() => readChunk(input, '', manifest, limits));
}

async function readChunk(
  input: unknown, path: string, manifest: ImportedHistoryManifest, limits: ImportedHistoryLimits,
): Promise<ImportedHistoryChunk> {
  const r = object(input, path, ['v', 'archiveId', 'index', 'records', 'chunkDigest']);
  const v = version(r.field('v'), r.at('v'));
  const archiveId = identifier(r.field('archiveId'), r.at('archiveId'));
  if (archiveId !== manifest.archiveId) fail(r.at('archiveId'), 'mismatch');
  const index = safeInteger(r.field('index'), r.at('index'));
  const entry = manifest.chunks[index];
  if (entry === undefined) fail(r.at('index'), 'invalid_value');
  const chunkDigest = digestField(r.field('chunkDigest'), r.at('chunkDigest'));
  const values = array(r.field('records'), r.at('records'));
  if (values.length > limits.maxRecordsPerChunk) fail(r.at('records'), 'too_long');
  if (values.length !== entry.recordCount) fail(r.at('records'), 'mismatch');
  const records: ImportedHistoryRecord[] = [];
  for (const [position, value] of values.entries()) {
    const at = elementPath(r.at('records'), position);
    const record = readRecord(value, at, limits);
    const previous = records.at(-1);
    if (previous !== undefined && record.sequence <= previous.sequence) fail(`${at}.sequence`, 'invalid_value');
    // The digest binds this body to this source record: a body whose digest belongs to another record fails here.
    if (await sha256(encodeImportedRecord(manifest.source.channelId, record)) !== record.recordDigest) fail(`${at}.recordDigest`, 'mismatch');
    records.push(record);
  }
  if (records[0]!.sequence !== entry.firstSequence || records.at(-1)!.sequence !== entry.lastSequence) fail(r.at('records'), 'mismatch');
  const chunk: ImportedHistoryChunk = { v, archiveId, index, records, chunkDigest };
  const bytes = encodeImportedHistoryChunk(chunk);
  if (bytes.byteLength > limits.maxChunkBytes) fail(r.at('records'), 'too_long');
  const digest = await sha256(bytes);
  if (digest !== chunkDigest || digest !== entry.chunkDigest) fail(r.at('chunkDigest'), 'mismatch');
  return chunk;
}

/**
 * Verifies a whole archive: the manifest, then every chunk in manifest order. A
 * missing, extra, reordered, altered or foreign chunk fails, as does a source record
 * that appears twice.
 */
export async function openImportedHistory(
  manifestInput: unknown, chunkInputs: unknown, limits: ImportedHistoryLimits,
): Promise<Decoded<VerifiedImportedHistory>> {
  const manifest = decodeImportedHistoryManifest(manifestInput, limits);
  if (!manifest.ok) return { ok: false, error: { path: `manifest${manifest.error.path ? `.${manifest.error.path}` : ''}`, code: manifest.error.code } };
  return decodeAsync(async () => {
    const values = array(chunkInputs, 'chunks');
    if (values.length !== manifest.value.chunks.length) fail('chunks', 'mismatch');
    const records: ImportedHistoryRecord[] = [];
    const seen = new Set<string>();
    for (const [position, value] of values.entries()) {
      const at = elementPath('chunks', position);
      const chunk = await readChunk(value, at, manifest.value, limits);
      if (chunk.index !== position) fail(`${at}.index`, 'mismatch');
      for (const record of chunk.records) {
        if (seen.has(record.sourceRecordId)) fail(`${at}.records`, 'duplicate');
        seen.add(record.sourceRecordId);
        records.push(record);
      }
    }
    return { manifest: manifest.value, records };
  });
}

export type SealImportedHistoryInput = Readonly<{
  archiveId: string;
  source: ImportedHistorySource;
  importedBy: ImportedHistoryActor;
  importedAt: string;
  records: readonly ImportedHistoryRecordInput[];
}>;

export type SealedImportedHistory = Readonly<{ manifest: ImportedHistoryManifest; chunks: readonly ImportedHistoryChunk[] }>;

/**
 * Deterministically seals source records into a manifest and bounded chunks. Records
 * are packed in order, and a chunk closes when the next record would exceed either
 * `maxRecordsPerChunk` or `maxChunkBytes`, so the same input always yields the same
 * bytes. Fails with `too_long` when one record cannot fit a chunk or the archive
 * needs more than `maxChunks`.
 */
export async function sealImportedHistory(input: unknown, limits: ImportedHistoryLimits): Promise<Decoded<SealedImportedHistory>> {
  return decodeAsync(async () => {
    const r = object(input, '', ['archiveId', 'source', 'importedBy', 'importedAt', 'records']);
    const archiveId = identifier(r.field('archiveId'), r.at('archiveId'));
    const source = readSource(r.field('source'), r.at('source'));
    const importedBy = readActor(r.field('importedBy'), r.at('importedBy'));
    const importedAt = utcTimestamp(r.field('importedAt'), r.at('importedAt'));
    const values = array(r.field('records'), r.at('records'));
    const groups: { records: ImportedHistoryRecord[]; bytes: number }[] = [];
    const seen = new Set<string>();
    for (const [position, value] of values.entries()) {
      const at = elementPath(r.at('records'), position);
      const fields = readRecordFields(object(value, at, RECORD_INPUT_KEYS), limits);
      const previous = groups.at(-1)?.records.at(-1);
      if (previous !== undefined && fields.sequence <= previous.sequence) fail(`${at}.sequence`, 'invalid_value');
      if (seen.has(fields.sourceRecordId)) fail(`${at}.sourceRecordId`, 'duplicate');
      seen.add(fields.sourceRecordId);
      const record: ImportedHistoryRecord = {
        v: 1, kind: 'imported', ...fields, recordDigest: await sha256(encodeImportedRecord(source.channelId, fields)),
      };
      // The chunk encoding ends `[t1,t2,...]]`, so each further record adds its tuple bytes plus one comma.
      const recordBytes = encoder.encode(JSON.stringify(chunkRecordTuple(record))).byteLength;
      const current = groups.at(-1);
      if (current !== undefined && current.records.length < limits.maxRecordsPerChunk
        && current.bytes + 1 + recordBytes <= limits.maxChunkBytes) {
        current.records.push(record);
        current.bytes += 1 + recordBytes;
        continue;
      }
      const bytes = encodeImportedHistoryChunk({ archiveId, index: groups.length, records: [] }).byteLength + recordBytes;
      if (bytes > limits.maxChunkBytes) fail(at, 'too_long');
      if (groups.length === limits.maxChunks) fail(r.at('records'), 'too_long');
      groups.push({ records: [record], bytes });
    }
    const chunks: ImportedHistoryChunk[] = [];
    for (const [index, { records }] of groups.entries()) {
      chunks.push({ v: 1, archiveId, index, records, chunkDigest: await sha256(encodeImportedHistoryChunk({ archiveId, index, records })) });
    }
    const manifest: ImportedHistoryManifest = {
      v: 1, archiveId, source, importedBy, importedAt, recordCount: values.length,
      chunks: chunks.map(chunk => ({
        index: chunk.index, recordCount: chunk.records.length, firstSequence: chunk.records[0]!.sequence,
        lastSequence: chunk.records.at(-1)!.sequence, chunkDigest: chunk.chunkDigest,
      })),
    };
    return { manifest, chunks };
  });
}
