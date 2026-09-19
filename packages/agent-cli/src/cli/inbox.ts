import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import type { BindingId, EventRef } from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import type { InboxCursor, InboxDelivery, InboxRecord } from './types.js';
import { plainObject, validDigest, validEventRef, validIdentifier, validUtcTimestamp } from './validation.js';

const INBOX_FILE = 'inbox.jsonl';
const CURSOR_FILE = 'cursor.json';
const SOCKET_FILE = 'listener.sock';
const RECORD_OVERHEAD_BYTES = 1024 * 1024;

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

export interface Inbox {
  enqueue(delivery: InboxDelivery): Promise<'appended' | 'duplicate'>;
  acquireListener(): Promise<Readonly<{ release(): Promise<void> }>>;
  readNext(): Promise<InboxItem | null>;
  acknowledge(item: InboxItem): Promise<void>;
  status(): Promise<InboxStatus>;
}

export type OpenInboxOptions = Readonly<{
  stateDirectory: string;
  bindingId: string;
  generation: number;
  maxPayloadBytes: number;
  maxSelectionEvents: number;
}>;

type ValidatedOptions = Omit<OpenInboxOptions, 'bindingId'> & Readonly<{ bindingId: BindingId }>;

export async function openInbox(options: OpenInboxOptions): Promise<Inbox> {
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
  const socketPath = await listenerSocketPath(bindingDirectory);
  return new FileInbox(validated, { bindingDirectory, inboxPath, cursorPath, socketPath });
}

type InboxPaths = Readonly<{ bindingDirectory: string; inboxPath: string; cursorPath: string; socketPath: string }>;

class FileInbox implements Inbox {
  readonly #options: ValidatedOptions;
  readonly #bindingDirectory: string;
  readonly #inboxPath: string;
  readonly #cursorPath: string;
  readonly #socketPath: string;
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
    this.#socketPath = paths.socketPath;
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

  async acquireListener(): Promise<Readonly<{ release(): Promise<void> }>> {
    let server = await listen(this.#socketPath);
    if (server === null) {
      if (await socketIsLive(this.#socketPath)) throw new CliError('listener_busy');
      await removeStaleSocket(this.#socketPath);
      server = await listen(this.#socketPath);
      if (server === null) throw new CliError('listener_busy');
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await new Promise<void>(resolve => server!.close(() => resolve()));
        await fsp.unlink(this.#socketPath).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CliError('storage_failed');
        });
      },
    };
  }

  async readNext(): Promise<InboxItem | null> {
    const cursor = await readCursor(this.#cursorPath);
    return readItemAt(this.#inboxPath, cursor.offset, this.#options);
  }

  async acknowledge(item: InboxItem): Promise<void> {
    await this.#serial(async () => {
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
    || options.maxSelectionEvents > 10_000) throw new CliError('invalid_input');
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

async function readItemAt(filename: string, offset: number, options: ValidatedOptions): Promise<InboxItem | null> {
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
        const decoded = decodeRecord(Buffer.concat(chunks, length).toString('utf8'), options);
        return { ...decoded, nextOffset: position + newline + 1 };
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
  const temporary = path.join(directory, `.cursor-${randomUUID()}.tmp`);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    await handle.writeFile(JSON.stringify(cursor) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filename);
    const directoryHandle = await fsp.open(directory, fs.constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    throw new CliError('storage_failed');
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(temporary).catch(() => undefined);
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

async function listen(socketPath: string): Promise<net.Server | null> {
  const server = net.createServer(socket => socket.end());
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
      resolve(server);
    });
  });
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
