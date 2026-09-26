import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import {
  type BindingId, type EventRef, OPENCODE_HINT_MAX_BYTES, type OpenCodeInboxHint, decodeOpenCodeInboxHint,
  encodeOpenCodeInboxHint,
} from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import type { InboxCursor, InboxDelivery, InboxRecord } from './types.js';
import { plainObject, validDigest, validEventRef, validIdentifier, validUtcTimestamp } from './validation.js';

const INBOX_FILE = 'inbox.jsonl';
const CURSOR_FILE = 'cursor.json';
const BATCH_FILE = 'batch.json';
const SOCKET_FILE = 'listener.sock';
const LISTENER_LOCK_FILE = 'listener.lock';
const RECORD_OVERHEAD_BYTES = 1024 * 1024;
const MAX_BATCH_RECORDS = 8;
const NOTIFY_DEADLINE_MS = 1000;

export type InboxItem = Readonly<{
  record: InboxRecord;
  payload: Uint8Array;
  nextOffset: number;
}>;

export type InboxStatus = Readonly<{
  bindingId: BindingId;
  generation: number;
  cursor: InboxCursor;
}>;

export type InboxBatch = Readonly<{
  token: string;
  items: readonly InboxItem[];
}>;

export type ReadBatchInput = Readonly<{
  maxBytes: number;
  acknowledgeToken?: string | null;
  /**
   * Opaque boundary identity, such as a hashed harness session and turn. When
   * present, the outstanding batch is returned only if it was not already
   * offered to this exact scope, nor returned by an explicit Khala call since its
   * last offer unless `turnStart` is set. The mark lives in the outstanding batch
   * state, so it ends with that batch's acknowledgement.
   */
  offerScope?: string;
  /** With `offerScope`: this boundary starts a turn, so a batch the agent already read is offered again. */
  turnStart?: boolean;
  /** An agent's own Khala call (explicit read or piggyback): always returns the batch and marks it seen. */
  explicitRead?: boolean;
}>;

/** The offer mark left by an explicit Khala call; boundary scopes can never equal it. */
const EXPLICIT_READ_SCOPE = 'khala-call';

export type InboxConsumer = Readonly<{
  readBatch(input: ReadBatchInput): Promise<InboxBatch | null>;
  release(): Promise<void>;
}>;

/**
 * A listener that can wait for content-free wakes. A wake only says "re-read the
 * durable batch": the hint names its binding generation and a reason, never a message,
 * body, token or release ID, and any number of pending wakes coalesce into one. The first wait after acquisition resolves at once, so a release stored while
 * no listener was running, or whose hint was lost to a crash, is caught up on start.
 */
export type WakeableInboxConsumer = InboxConsumer & Readonly<{
  nextWake(): Promise<void>;
}>;

/** Why a hint was sent: a release became durable, or a restarted sender is catching up. */
export type ListenerHintReason = OpenCodeInboxHint['reason'];

/**
 * `notified`: this binding generation's live listener received the hint.
 * `unavailable`: no live listener accepted it. The durable batch is untouched and is
 * caught up when a listener next starts.
 */
export type ListenerNotification = 'notified' | 'unavailable';

export interface Inbox {
  enqueue(delivery: InboxDelivery): Promise<'appended' | 'duplicate'>;
  acquireListener(): Promise<Readonly<{ release(): Promise<void> }>>;
  readNext(): Promise<InboxItem | null>;
  acknowledge(item: InboxItem): Promise<void>;
  status(): Promise<InboxStatus>;
}

export interface BatchInbox extends Inbox {
  acquireListener(): Promise<WakeableInboxConsumer>;
  /** Wakes only this binding generation's listener; the socket path never leaves the inbox. */
  notifyListener(reason: ListenerHintReason): Promise<ListenerNotification>;
}

/**
 * A content-free acknowledgement of one outstanding batch: the held binding and the
 * release IDs of that batch's committed prefix, in order. It never carries the token.
 */
export type BatchAcknowledgement = Readonly<{
  bindingId: BindingId;
  generation: number;
  releaseIds: readonly string[];
}>;

/**
 * Consumer hook for the batch-token acknowledgement. It must durably record the
 * acknowledgement, or throw; the cursor advances only after it resolves.
 */
export type BatchAcknowledgementRecorder = (acknowledgement: BatchAcknowledgement) => Promise<void>;

export type OpenInboxOptions = Readonly<{
  stateDirectory: string;
  bindingId: string;
  generation: number;
  maxPayloadBytes: number;
  maxSelectionEvents: number;
  recordAcknowledgement?: BatchAcknowledgementRecorder;
}>;

type ValidatedOptions = Omit<OpenInboxOptions, 'bindingId'> & Readonly<{ bindingId: BindingId }>;

export async function openInbox(options: OpenInboxOptions): Promise<BatchInbox> {
  const validated = validateOptions(options);
  const stateDirectory = path.resolve(options.stateDirectory);
  if (!path.isAbsolute(options.stateDirectory)) throw new CliError('invalid_input');
  await ensurePrivateDirectory(stateDirectory);
  const bindingsDirectory = path.join(stateDirectory, 'bindings');
  await ensurePrivateDirectory(bindingsDirectory);
  const bindingDirectory = path.join(
    bindingsDirectory,
    createHash('sha256').update(JSON.stringify([validated.bindingId, validated.generation])).digest('base64url'),
  );
  await ensurePrivateDirectory(bindingDirectory);
  const inboxPath = path.join(bindingDirectory, INBOX_FILE);
  await ensurePrivateFile(inboxPath);
  await recoverTrailingWrite(inboxPath);
  const cursorPath = path.join(bindingDirectory, CURSOR_FILE);
  const batchPath = path.join(bindingDirectory, BATCH_FILE);
  const socketPath = await listenerSocketPath(bindingDirectory);
  const listenerLockPath = path.join(bindingDirectory, LISTENER_LOCK_FILE);
  return new FileInbox(validated, { bindingDirectory, inboxPath, cursorPath, batchPath, socketPath, listenerLockPath });
}

type InboxPaths = Readonly<{
  bindingDirectory: string;
  inboxPath: string;
  cursorPath: string;
  batchPath: string;
  socketPath: string;
  listenerLockPath: string;
}>;

class FileInbox implements BatchInbox {
  readonly #options: ValidatedOptions;
  readonly #bindingDirectory: string;
  readonly #inboxPath: string;
  readonly #cursorPath: string;
  readonly #batchPath: string;
  readonly #socketPath: string;
  readonly #listenerLockPath: string;
  // TODO(KHA-153): compact acknowledged records once live composition defines retention.
  #known: Map<string, string> | null = null;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    options: ValidatedOptions,
    paths: InboxPaths,
  ) {
    this.#options = options;
    this.#bindingDirectory = paths.bindingDirectory;
    this.#inboxPath = paths.inboxPath;
    this.#cursorPath = paths.cursorPath;
    this.#batchPath = paths.batchPath;
    this.#socketPath = paths.socketPath;
    this.#listenerLockPath = paths.listenerLockPath;
  }

  async enqueue(delivery: InboxDelivery): Promise<'appended' | 'duplicate'> {
    return this.#serial(async () => {
      const record = recordFromDelivery(delivery, this.#options);
      const encoded = JSON.stringify(record);
      const fingerprint = recordFingerprint(encoded);
      const known = this.#known ??= await loadKnown(this.#inboxPath, this.#options);
      const previous = known.get(record.releaseId);
      if (previous !== undefined) {
        if (previous !== fingerprint) throw new CliError('invalid_input');
        return 'duplicate';
      }
      const handle = await openNoFollow(this.#inboxPath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      let failed = false;
      try {
        await handle.writeFile(encoded + '\n', 'utf8');
        await handle.sync();
      } catch {
        failed = true;
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (failed) {
        this.#known = null;
        await recoverTrailingWrite(this.#inboxPath);
        throw new CliError('storage_failed');
      }
      known.set(record.releaseId, fingerprint);
      return 'appended';
    });
  }

  async acquireListener(): Promise<WakeableInboxConsumer> {
    const lock = await acquireListenerLock(this.#listenerLockPath);
    // Starting is itself a catch-up wake: a release may have become durable while no
    // listener ran, or its hint may have been lost between append and notification.
    let pending = true;
    let released = false;
    let waiter: Readonly<{ resolve(): void; reject(error: Error): void }> | null = null;
    const wake = () => {
      if (released) return;
      if (waiter === null) {
        pending = true;
        return;
      }
      const current = waiter;
      waiter = null;
      current.resolve();
    };
    let server: ListenerSocket | null = null;
    try {
      server = await listen(this.#socketPath, this.#ownsHint, wake);
      if (server === null) {
        if (await socketIsLive(this.#socketPath)) throw new CliError('listener_busy');
        await removeStaleSocket(this.#socketPath);
        server = await listen(this.#socketPath, this.#ownsHint, wake);
        if (server === null) throw new CliError('listener_busy');
      }
    } catch (error) {
      await lock.release();
      throw error;
    }
    return {
      readBatch: input => this.#readBatch(input, () => !released),
      nextWake: () => {
        if (released) return Promise.reject(new CliError('listener_busy'));
        if (waiter !== null) return Promise.reject(new CliError('invalid_input'));
        if (pending) {
          pending = false;
          return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
          waiter = { resolve, reject };
        });
      },
      release: async () => {
        if (released) return;
        released = true;
        pending = false;
        if (waiter !== null) {
          const current = waiter;
          waiter = null;
          current.reject(new CliError('listener_busy'));
        }
        await server!.close();
        let failed = false;
        try {
          await fsp.unlink(this.#socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true;
        }
        try {
          await lock.release();
        } catch {
          failed = true;
        }
        if (failed) throw new CliError('storage_failed');
      },
    };
  }

  async notifyListener(reason: ListenerHintReason): Promise<ListenerNotification> {
    const { bindingId, generation } = this.#options;
    return notifySocket(
      this.#socketPath,
      encodeOpenCodeInboxHint({ v: 1, kind: 'khala.inbox.hint', bindingId, generation, reason }),
    );
  }

  // Only a hint for exactly this binding generation wakes its listener.
  readonly #ownsHint = (hint: OpenCodeInboxHint): boolean =>
    hint.bindingId === this.#options.bindingId && hint.generation === this.#options.generation;

  async readNext(): Promise<InboxItem | null> {
    const cursor = await readCursor(this.#cursorPath);
    return readItemAt(this.#inboxPath, cursor.offset, this.#options);
  }

  async #readBatch(input: ReadBatchInput, ownsListener: () => boolean): Promise<InboxBatch | null> {
    if (!ownsListener()) throw new CliError('listener_busy');
    if (input === null || typeof input !== 'object' || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0
      || !(input.acknowledgeToken === undefined || input.acknowledgeToken === null
        || typeof input.acknowledgeToken === 'string')
      || !(input.offerScope === undefined
        || (validIdentifier(input.offerScope) && input.offerScope !== EXPLICIT_READ_SCOPE))
      || !(input.turnStart === undefined || (typeof input.turnStart === 'boolean' && input.offerScope !== undefined))
      || !(input.explicitRead === undefined || typeof input.explicitRead === 'boolean')
      || (input.explicitRead === true && input.offerScope !== undefined)) throw new CliError('invalid_input');
    return this.#serial(async () => {
      if (!ownsListener()) throw new CliError('listener_busy');
      let cursor = await readCursor(this.#cursorPath);
      let outstanding = await readBatchState(this.#batchPath, this.#inboxPath, this.#options);
      if (outstanding !== null) {
        if (cursor.offset === outstanding.state.endOffset && cursor.releaseId === outstanding.state.releaseId) {
          await removeBatchState(this.#batchPath, this.#bindingDirectory);
          outstanding = null;
        } else if (cursor.offset !== outstanding.state.startOffset) {
          throw new CliError('storage_failed');
        }
      }
      if (outstanding !== null && input.acknowledgeToken === outstanding.state.token) {
        // The receipt commits before the cursor moves. If recording fails the cursor
        // stays put and the same batch replays; a replayed acknowledgement returns the
        // receipts already recorded, so a crash between the two stores loses nothing.
        await this.#recordAcknowledgement(outstanding.batch);
        await writeCursorAtomic(this.#cursorPath, this.#bindingDirectory, {
          v: 1, offset: outstanding.state.endOffset, releaseId: outstanding.state.releaseId,
        });
        await removeBatchState(this.#batchPath, this.#bindingDirectory);
        cursor = { v: 1, offset: outstanding.state.endOffset, releaseId: outstanding.state.releaseId };
        outstanding = null;
      }
      if (outstanding !== null) {
        const mark = input.explicitRead === true ? EXPLICIT_READ_SCOPE : input.offerScope;
        if (mark === undefined) return outstanding.batch;
        const previous = outstanding.state.offeredScope;
        if (mark !== EXPLICIT_READ_SCOPE
          && (previous === mark || (previous === EXPLICIT_READ_SCOPE && input.turnStart !== true))) return null;
        if (previous !== mark) {
          await writeBatchStateAtomic(this.#batchPath, this.#bindingDirectory, { ...outstanding.state, offeredScope: mark });
        }
        return outstanding.batch;
      }

      const records: string[] = [];
      const items: InboxItem[] = [];
      let offset = cursor.offset;
      let payloadBytes = 0;
      let releaseId: string | null = null;
      while (records.length < MAX_BATCH_RECORDS) {
        const item = await readStoredItemAt(this.#inboxPath, offset, this.#options);
        if (item === null) break;
        if (records.length > 0 && payloadBytes + item.payload.byteLength > input.maxBytes) break;
        records.push(item.encoded);
        items.push({ record: item.record, payload: item.payload, nextOffset: item.nextOffset });
        payloadBytes += item.payload.byteLength;
        offset = item.nextOffset;
        releaseId = item.record.releaseId;
      }
      if (records.length === 0 || releaseId === null) return null;
      const state: BatchState = {
        v: 1,
        bindingId: this.#options.bindingId,
        generation: this.#options.generation,
        token: randomUUID(),
        startOffset: cursor.offset,
        endOffset: offset,
        releaseId,
        records,
        ...(input.explicitRead === true ? { offeredScope: EXPLICIT_READ_SCOPE }
          : input.offerScope === undefined ? {} : { offeredScope: input.offerScope }),
      };
      await writeBatchStateAtomic(this.#batchPath, this.#bindingDirectory, state);
      return { token: state.token, items };
    });
  }

  async #recordAcknowledgement(batch: InboxBatch): Promise<void> {
    const record = this.#options.recordAcknowledgement;
    if (record === undefined) return;
    try {
      await record({
        bindingId: this.#options.bindingId,
        generation: this.#options.generation,
        releaseIds: batch.items.map(item => item.record.releaseId),
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('storage_failed');
    }
  }

  async acknowledge(item: InboxItem): Promise<void> {
    await this.#serial(async () => {
      if (await readBatchState(this.#batchPath, this.#inboxPath, this.#options) !== null) throw new CliError('invalid_input');
      const cursor = await readCursor(this.#cursorPath);
      const current = await readItemAt(this.#inboxPath, cursor.offset, this.#options);
      if (current === null || current.nextOffset !== item.nextOffset
        || current.record.releaseId !== item.record.releaseId) throw new CliError('invalid_input');
      await writeCursorAtomic(
        this.#cursorPath,
        this.#bindingDirectory,
        { v: 1, offset: current.nextOffset, releaseId: current.record.releaseId },
      );
    });
  }

  async status(): Promise<InboxStatus> {
    return {
      bindingId: this.#options.bindingId,
      generation: this.#options.generation,
      cursor: await readCursor(this.#cursorPath),
    };
  }

  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(work, work);
    this.#writes = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateOptions(options: OpenInboxOptions): ValidatedOptions {
  if (!validIdentifier(options.bindingId) || !Number.isSafeInteger(options.generation) || options.generation < 0
    || !Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1
    || options.maxPayloadBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(options.maxSelectionEvents) || options.maxSelectionEvents < 1
    || options.maxSelectionEvents > 10_000
    || !(options.recordAcknowledgement === undefined || typeof options.recordAcknowledgement === 'function')) {
    throw new CliError('invalid_input');
  }
  return { ...options, bindingId: options.bindingId as BindingId };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(directory);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) {
      throw new CliError('storage_failed');
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
}

async function ensurePrivateFile(filename: string): Promise<void> {
  try {
    const handle = await fsp.open(
      filename,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    ).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return null;
    });
    await handle?.close();
    const stat = await fsp.lstat(filename);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (uid !== null && stat.uid !== uid)) throw new CliError('storage_failed');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
}

async function openNoFollow(filename: string, flags: number): Promise<fsp.FileHandle> {
  try {
    return await fsp.open(filename, flags | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new CliError('storage_failed');
  }
}

async function recoverTrailingWrite(filename: string): Promise<void> {
  const handle = await openNoFollow(filename, fs.constants.O_RDWR);
  try {
    const { size } = await handle.stat();
    if (size === 0) return;
    const chunkSize = 64 * 1024;
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const bytes = Buffer.alloc(end - start);
      await handle.read(bytes, 0, bytes.length, start);
      const newline = bytes.lastIndexOf(0x0a);
      if (newline >= 0) {
        const complete = start + newline + 1;
        if (complete !== size) {
          await handle.truncate(complete);
          await handle.sync();
        }
        return;
      }
      end = start;
    }
    await handle.truncate(0);
    await handle.sync();
  } catch {
    throw new CliError('storage_failed');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function loadKnown(filename: string, options: ValidatedOptions): Promise<Map<string, string>> {
  try {
    const known = new Map<string, string>();
    const lines = readline.createInterface({ input: fs.createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      const record = decodeRecord(line, options).record;
      const fingerprint = recordFingerprint(line);
      const previous = known.get(record.releaseId);
      if (previous !== undefined && previous !== fingerprint) throw new CliError('storage_failed');
      known.set(record.releaseId, fingerprint);
    }
    return known;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
}

function recordFingerprint(encoded: string): string {
  return createHash('sha256').update(encoded).digest('hex');
}

function recordFromDelivery(delivery: InboxDelivery, options: ValidatedOptions): InboxRecord {
  if (delivery === null || typeof delivery !== 'object' || delivery.v !== 1
    || delivery.bindingId !== options.bindingId || delivery.generation !== options.generation
    || !validIdentifier(delivery.releaseId) || !Array.isArray(delivery.events) || delivery.events.length === 0
    || delivery.events.length > options.maxSelectionEvents
    || !(delivery.payload instanceof Uint8Array) || delivery.payload.byteLength > options.maxPayloadBytes
    || !validDigest(delivery.payloadDigest) || digest(delivery.payload) !== delivery.payloadDigest
    || !validUtcTimestamp(delivery.receivedAt)) {
    throw new CliError('invalid_input');
  }
  for (const event of delivery.events) if (!validEventRef(event)) throw new CliError('invalid_input');
  return {
    v: 1,
    releaseId: delivery.releaseId,
    bindingId: delivery.bindingId,
    generation: delivery.generation,
    events: delivery.events,
    payloadDigest: delivery.payloadDigest,
    payloadBase64: Buffer.from(delivery.payload).toString('base64'),
    receivedAt: delivery.receivedAt,
  };
}

function decodeRecord(line: string, options: ValidatedOptions): { record: InboxRecord; payload: Uint8Array } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CliError('storage_failed');
  }
  if (!plainObject(value)) throw new CliError('storage_failed');
  const keys = ['v', 'releaseId', 'bindingId', 'generation', 'events', 'payloadDigest', 'payloadBase64', 'receivedAt'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new CliError('storage_failed');
  if (value.v !== 1 || value.bindingId !== options.bindingId || value.generation !== options.generation
    || !validIdentifier(value.releaseId) || !Array.isArray(value.events) || value.events.length === 0
    || value.events.length > options.maxSelectionEvents
    || !validDigest(value.payloadDigest) || typeof value.payloadBase64 !== 'string'
    || !validUtcTimestamp(value.receivedAt)) throw new CliError('storage_failed');
  const events: EventRef[] = [];
  for (const event of value.events) {
    if (!validEventRef(event)) throw new CliError('storage_failed');
    events.push(event);
  }
  const record: InboxRecord = {
    v: 1,
    releaseId: value.releaseId,
    bindingId: options.bindingId,
    generation: options.generation,
    events,
    payloadDigest: value.payloadDigest,
    payloadBase64: value.payloadBase64,
    receivedAt: value.receivedAt,
  };
  const payload = decodeBase64(record.payloadBase64);
  if (payload === null || payload.byteLength > options.maxPayloadBytes || digest(payload) !== record.payloadDigest) {
    throw new CliError('storage_failed');
  }
  return { record, payload };
}

type StoredInboxItem = InboxItem & Readonly<{ encoded: string }>;

type BatchState = Readonly<{
  v: 1;
  bindingId: BindingId;
  generation: number;
  token: string;
  startOffset: number;
  endOffset: number;
  releaseId: string;
  records: readonly string[];
  offeredScope?: string;
}>;

type LoadedBatchState = Readonly<{ state: BatchState; batch: InboxBatch }>;

async function readBatchState(
  filename: string,
  inboxPath: string,
  options: ValidatedOptions,
): Promise<LoadedBatchState | null> {
  let encoded: string;
  try {
    encoded = await readPrivateUtf8File(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new CliError('storage_failed');
  }
  const keys = ['v', 'bindingId', 'generation', 'token', 'startOffset', 'endOffset', 'releaseId', 'records'];
  const offered = plainObject(value) && Object.hasOwn(value, 'offeredScope');
  if (!plainObject(value) || Object.keys(value).length !== keys.length + (offered ? 1 : 0)
    || keys.some(key => !Object.hasOwn(value, key)) || (offered && !validIdentifier(value.offeredScope))
    || value.v !== 1 || value.bindingId !== options.bindingId || value.generation !== options.generation
    || !validIdentifier(value.token) || !Number.isSafeInteger(value.startOffset) || typeof value.startOffset !== 'number'
    || value.startOffset < 0 || !Number.isSafeInteger(value.endOffset) || typeof value.endOffset !== 'number'
    || value.endOffset <= value.startOffset || !validIdentifier(value.releaseId) || !Array.isArray(value.records)
    || value.records.length === 0 || value.records.length > MAX_BATCH_RECORDS
    || value.records.some(record => typeof record !== 'string')) throw new CliError('storage_failed');
  const records = value.records as string[];
  const items: InboxItem[] = [];
  let offset = value.startOffset;
  let lastReleaseId: string | null = null;
  for (const record of records) {
    const item = await readStoredItemAt(inboxPath, offset, options);
    if (item === null || item.encoded !== record) throw new CliError('storage_failed');
    items.push({ record: item.record, payload: item.payload, nextOffset: item.nextOffset });
    offset = item.nextOffset;
    lastReleaseId = item.record.releaseId;
  }
  if (offset !== value.endOffset || lastReleaseId !== value.releaseId) throw new CliError('storage_failed');
  const state: BatchState = {
    v: 1,
    bindingId: options.bindingId,
    generation: options.generation,
    token: value.token,
    startOffset: value.startOffset,
    endOffset: value.endOffset,
    releaseId: value.releaseId,
    records,
    ...(offered ? { offeredScope: value.offeredScope as string } : {}),
  };
  return { state, batch: { token: state.token, items } };
}

async function writeBatchStateAtomic(filename: string, directory: string, state: BatchState): Promise<void> {
  await writeAtomicJson(filename, directory, `.batch-${randomUUID()}.tmp`, state);
}

async function removeBatchState(filename: string, directory: string): Promise<void> {
  try {
    await fsp.unlink(filename);
    await syncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CliError('storage_failed');
  }
}

async function readItemAt(filename: string, offset: number, options: ValidatedOptions): Promise<InboxItem | null> {
  const stored = await readStoredItemAt(filename, offset, options);
  if (stored === null) return null;
  return { record: stored.record, payload: stored.payload, nextOffset: stored.nextOffset };
}

async function readStoredItemAt(filename: string, offset: number, options: ValidatedOptions): Promise<StoredInboxItem | null> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CliError('storage_failed');
  const handle = await openNoFollow(filename, fs.constants.O_RDONLY);
  try {
    const { size } = await handle.stat();
    if (offset === size) return null;
    if (offset > size) throw new CliError('storage_failed');
    const maximum = options.maxPayloadBytes * 2 + RECORD_OVERHEAD_BYTES;
    const chunks: Buffer[] = [];
    let length = 0;
    let position = offset;
    while (position < size && length <= maximum) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        length += newline;
        const encoded = decodeUtf8(Buffer.concat(chunks, length));
        const decoded = decodeRecord(encoded, options);
        return { ...decoded, encoded, nextOffset: position + newline + 1 };
      }
      chunks.push(chunk);
      length += bytesRead;
      position += bytesRead;
    }
    if (length > maximum) throw new CliError('storage_failed');
    return null;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readCursor(filename: string): Promise<InboxCursor> {
  let text: string;
  try {
    text = await fsp.readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, offset: 0, releaseId: null };
    throw new CliError('storage_failed');
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!plainObject(value) || Object.keys(value).length !== 3 || value.v !== 1) {
      throw new CliError('storage_failed');
    }
    const { offset, releaseId } = value;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
      || !(releaseId === null || validIdentifier(releaseId))) throw new CliError('storage_failed');
    return { v: 1, offset, releaseId };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
}

async function writeCursorAtomic(filename: string, directory: string, cursor: InboxCursor): Promise<void> {
  await writeAtomicJson(filename, directory, `.cursor-${randomUUID()}.tmp`, cursor);
}

async function writeAtomicJson(filename: string, directory: string, temporaryName: string, value: unknown): Promise<void> {
  const temporary = path.join(directory, temporaryName);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filename);
    await syncDirectory(directory);
  } catch {
    throw new CliError('storage_failed');
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateUtf8File(filename: string): Promise<string> {
  const stat = await fsp.lstat(filename);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || (uid !== null && stat.uid !== uid)) throw new CliError('storage_failed');
  const handle = await openNoFollow(filename, fs.constants.O_RDONLY);
  try {
    return decodeUtf8(await handle.readFile());
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CliError('storage_failed');
  }
}

type ListenerLockRecord = Readonly<{ v: 1; pid: number; token: string }>;

async function acquireListenerLock(filename: string): Promise<Readonly<{ release(): Promise<void> }>> {
  const record: ListenerLockRecord = { v: 1, pid: process.pid, token: randomUUID() };
  while (true) {
    if (createListenerLock(filename, record)) {
      let released = false;
      return {
        release: async () => {
          if (released) return;
          const current = await readListenerLock(filename);
          if (current.pid !== record.pid || current.token !== record.token) throw new CliError('storage_failed');
          try {
            await fsp.unlink(filename);
          } catch {
            throw new CliError('storage_failed');
          }
          released = true;
        },
      };
    }
    const existing = await readListenerLock(filename);
    if (processIsLive(existing.pid)) throw new CliError('listener_busy');
    await quarantineStaleListenerLock(filename, existing);
  }
}

function createListenerLock(filename: string, record: ListenerLockRecord): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, JSON.stringify(record) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    if (descriptor !== null) {
      try {
        fs.unlinkSync(filename);
      } catch {
        // The original storage failure remains authoritative.
      }
    }
    throw new CliError('storage_failed');
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function readListenerLock(filename: string): Promise<ListenerLockRecord> {
  try {
    const stat = await fsp.lstat(filename);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (uid !== null && stat.uid !== uid)) throw new CliError('storage_failed');
    const handle = await openNoFollow(filename, fs.constants.O_RDONLY);
    let text: string;
    try {
      text = await handle.readFile('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
    const value: unknown = JSON.parse(text);
    if (!plainObject(value) || Object.keys(value).length !== 3 || value.v !== 1
      || !Number.isSafeInteger(value.pid) || typeof value.pid !== 'number' || value.pid < 1
      || typeof value.token !== 'string' || !validIdentifier(value.token)) throw new CliError('storage_failed');
    return { v: 1, pid: value.pid, token: value.token };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw new CliError('storage_failed');
  }
}

async function quarantineStaleListenerLock(filename: string, stale: ListenerLockRecord): Promise<void> {
  const quarantine = `${filename}.stale-${randomUUID()}`;
  try {
    await fsp.rename(filename, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new CliError('storage_failed');
  }
  try {
    const moved = await readListenerLock(quarantine);
    if (moved.pid !== stale.pid || moved.token !== stale.token || processIsLive(moved.pid)) {
      try {
        await fsp.link(quarantine, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CliError('storage_failed');
      }
      throw new CliError('listener_busy');
    }
  } finally {
    await fsp.unlink(quarantine).catch(() => undefined);
  }
}

async function listenerSocketPath(bindingDirectory: string): Promise<string> {
  const direct = path.join(bindingDirectory, SOCKET_FILE);
  if (Buffer.byteLength(direct) < 100) return direct;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const root = path.join('/tmp', `.khala-agent-cli-${uid}`);
  await ensurePrivateDirectory(root);
  return path.join(root, `${createHash('sha256').update(bindingDirectory).digest('hex').slice(0, 32)}.sock`);
}

/**
 * The hint protocol: connect, write one `\n`-terminated hint line in the
 * `encodeOpenCodeInboxHint` wire format, half-close, then wait for the listener's EOF.
 * The listener never writes. It wakes only for a valid hint naming its own binding
 * generation, so `notified` means a live listener received the line, not that it woke.
 */
async function notifySocket(socketPath: string, line: string): Promise<ListenerNotification> {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
    const settle = (outcome: ListenerNotification) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle('unavailable'), NOTIFY_DEADLINE_MS);
    socket.once('connect', () => socket.end(line));
    socket.on('data', () => settle('unavailable'));
    socket.once('end', () => settle('notified'));
    socket.once('error', () => settle('unavailable'));
    socket.once('close', () => settle('unavailable'));
  });
}

type ListenerSocket = Readonly<{ close(): Promise<void> }>;

async function listen(
  socketPath: string,
  owns: (hint: OpenCodeInboxHint) => boolean,
  onWake: () => void,
): Promise<ListenerSocket | null> {
  const connections = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    // Anything but one valid hint line for this binding generation wakes nothing.
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > OPENCODE_HINT_MAX_BYTES) socket.destroy();
      else chunks.push(chunk);
    });
    socket.once('end', () => {
      const hint = readHintLine(Buffer.concat(chunks));
      if (hint === null || !owns(hint)) {
        socket.destroy();
        return;
      }
      onWake();
      socket.end();
    });
  });
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(new CliError('storage_failed'));
    };
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      server.on('error', () => undefined);
      resolve({
        // A peer that never half-closes must not hold the release open.
        close: () => new Promise<void>(done => {
          server.close(() => done());
          for (const socket of connections) socket.destroy();
        }),
      });
    });
  });
}

/** Exactly one `\n`-terminated, valid UTF-8 hint line, or nothing. */
function readHintLine(bytes: Buffer): OpenCodeInboxHint | null {
  let line: string;
  try {
    line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!line.endsWith('\n')) return null;
  const hint = decodeOpenCodeInboxHint(line);
  return hint.ok ? hint.value : null;
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await fsp.lstat(socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink()) throw new CliError('storage_failed');
    await fsp.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? new Uint8Array(decoded) : null;
}
