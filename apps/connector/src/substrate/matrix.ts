// Owner connector Matrix substrate. Rust crypto runs in an isolated, persistent Chromium
// profile because matrix-js-sdk 42.4.0 documents IndexedDB as its durable crypto store;
// its Node in-memory mode would replace the device on restart. The browser is a local
// owner endpoint, never a model/agent process. All content remains in the connector until
// the review/release pipeline decides what the bound agent may see.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { encodeMessageContent, type DeviceId, type EventId, type ParticipantId, type RoomId } from '@khala/contracts/messaging/index';
import type { ConnectorDevicePort, DeviceActivation, DeviceStatus } from '@khala/connector/bootstrap/ports';
import type { AuthorityCheck, SourceEvent, SourceListener, SourceRead, SubscriptionSource } from '@khala/connector/subscription/adapter';

type BrowserEvent = Readonly<{
  eventId: string; roomId: string; senderUserId: string; senderDeviceId: string | null;
  body: string | null; failure: 'missing_keys' | 'withheld_unverified' | 'withheld' | 'decrypt_failed' | 'unsupported' | null;
}>;
type BrowserPage = Readonly<{ events: readonly BrowserEvent[]; nextCursor: string; limited: boolean }>;
type BrowserOpen = Readonly<{ fingerprint: string; deviceId: string }>;

export type MatrixConnectorInput = Readonly<{
  /** The server-provisioned agent Matrix session. It must be the same device on every restart. */
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  roomId: string;
  /** Owner-private directory; browser IndexedDB lives in `profile/` below it. */
  profileDirectory: string;
  /** Authenticated mapping from Matrix sender user IDs to Khala participants. */
  participantIdFor: (matrixUserId: string) => ParticipantId | null;
  chromiumExecutablePath?: string;
  browserBundleDirectory?: string;
}>;

export type MatrixConnectorSubstrate = Readonly<{
  devices: ConnectorDevicePort;
  source: SubscriptionSource;
  fingerprint: string;
  /** Encrypts one agent-authored message with the same durable Matrix device. */
  send(clientTxnId: string, body: string): Promise<{ eventId: string }>;
  /** Explicit trust only after an authenticated owner-approved fingerprint attestation. */
  trustPeer(userId: string, deviceId: string, expectedEd25519: string): Promise<void>;
  close(): Promise<void>;
}>;

type Marker = Readonly<{ v: 1; userId: string; deviceId: string; fingerprint: string; port: number }>;
type Reservation = Readonly<{ v: 1; operations: Readonly<Record<string, string>>; activated: readonly string[] }>;
const EMPTY: Reservation = { v: 1, operations: {}, activated: [] };

function bundleDirectory(): string {
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/substrate-browser');
  const built = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../substrate-browser');
  return existsSync(path.join(local, 'index.html')) ? local : built;
}

function fileFor(root: string, name: string): string { return path.join(root, name); }

async function writeJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    const handle = await open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

async function readReservation(filename: string): Promise<Reservation> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('v' in parsed) || parsed.v !== 1
      || !('operations' in parsed) || typeof parsed.operations !== 'object' || parsed.operations === null
      || !('activated' in parsed) || !Array.isArray(parsed.activated)) throw new Error('matrix_reservation_corrupt');
    return parsed as Reservation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw error;
  }
}

async function staticServer(root: string, port: number): Promise<{ server: Server; origin: string; port: number }> {
  if (!existsSync(path.join(root, 'index.html'))) throw new Error('matrix_browser_bundle_missing');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(target);
      const contentType = target.endsWith('.js') ? 'text/javascript' : target.endsWith('.wasm') ? 'application/wasm'
        : target.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('matrix_local_server_unavailable');
  return { server, origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(async ([name, values]) => {
    const api = (window as unknown as { khalaMatrix: Record<string, (...values: unknown[]) => Promise<unknown>> }).khalaMatrix;
    if (!api || typeof api[name] !== 'function') throw new Error('matrix_browser_method_missing');
    return api[name](...values);
  }, [method, args] as const) as Promise<T>;
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new Error('matrix_call_aborted');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('matrix_call_aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/**
 * Opens exactly one writer. A stale lock after abrupt death is a deliberate repair gate:
 * the operator checks the old process is gone before removing that one owned lock.
 */
export async function openMatrixConnectorSubstrate(input: MatrixConnectorInput): Promise<MatrixConnectorSubstrate> {
  if (!input.baseUrl.startsWith('https://') && !input.baseUrl.startsWith('http://127.0.0.1:'))
    throw new Error('matrix_origin_untrusted');
  await mkdir(input.profileDirectory, { recursive: true, mode: 0o700 });
  const lockPath = fileFor(input.profileDirectory, 'writer.lock');
  const lock: FileHandle = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('matrix_device_locked'); });
  await lock.writeFile(String(process.pid));
  let context: BrowserContext | null = null;
  let server: Server | null = null;
  let page: Page | null = null;
  try {
    const profile = fileFor(input.profileDirectory, 'profile');
    const markerPath = fileFor(input.profileDirectory, 'identity.json');
    const prior = await readFile(markerPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (prior !== null && !existsSync(profile)) throw new Error('matrix_crypto_store_lost');
    let previous: Marker | null = null;
    if (prior !== null) {
      previous = JSON.parse(prior) as Marker;
      if (previous.v !== 1 || previous.userId !== input.userId || previous.deviceId !== input.deviceId
        || !Number.isSafeInteger(previous.port) || previous.port < 1 || previous.port > 65535)
        throw new Error('matrix_identity_changed');
    }
    const serving = await staticServer(path.resolve(input.browserBundleDirectory ?? bundleDirectory()), previous?.port ?? 0);
    server = serving.server;
    context = await chromium.launchPersistentContext(profile, {
      executablePath: input.chromiumExecutablePath ?? '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'],
    });
    page = await context.newPage();
    const listeners = new Set<SourceListener>();
    await page.exposeFunction('khalaHint', (lost?: boolean) => {
      for (const listener of listeners) { if (lost) listener.lost(); else listener.hint(); }
    });
    await page.goto(serving.origin);
    await page.waitForFunction(() => typeof (window as unknown as { khalaMatrix?: unknown }).khalaMatrix === 'object');
    const identity = await call<BrowserOpen>(page, 'open', {
      baseUrl: input.baseUrl, userId: input.userId, deviceId: input.deviceId, accessToken: input.accessToken,
      roomId: input.roomId, storeName: 'khala-owner-connector',
    });
    const marker: Marker = { v: 1, userId: input.userId, deviceId: input.deviceId, fingerprint: identity.fingerprint, port: serving.port };
    if (prior !== null && prior !== JSON.stringify(marker)) throw new Error('matrix_identity_changed');
    if (prior === null) await writeJson(markerPath, marker);
    const reservationPath = fileFor(input.profileDirectory, 'reservations.json');
    let reservation = await readReservation(reservationPath);
    const outgoingDirectory = fileFor(input.profileDirectory, 'outgoing');
    await mkdir(outgoingDirectory, { recursive: true, mode: 0o700 });
    let sending = Promise.resolve();
    const serializeSend = async <T>(work: () => Promise<T>): Promise<T> => {
      const running = sending.then(work, work);
      sending = running.then(() => undefined, () => undefined);
      return running;
    };
    let closed = false;
    const current = () => { if (closed || !page) throw new Error('matrix_device_closed'); return page; };
    const devices: ConnectorDevicePort = {
      async reserve(operationId) {
        if (closed || !operationId) return { kind: 'unavailable' };
        const existing = reservation.operations[operationId];
        if (existing && existing !== input.deviceId) return { kind: 'unavailable' };
        if (!existing) {
          reservation = { ...reservation, operations: { ...reservation.operations, [operationId]: input.deviceId } };
          await writeJson(reservationPath, reservation);
        }
        return { kind: 'reserved', deviceId: input.deviceId };
      },
      async activate(activation): Promise<DeviceActivation> {
        if (closed || activation.deviceId !== input.deviceId || activation.binding.deviceId !== input.deviceId
          || reservation.operations[activation.operationId] !== input.deviceId) return { kind: 'failed', reason: 'capability_rejected' };
        if (activation.capability.bindingId !== activation.binding.bindingId
          || activation.capability.generation !== activation.binding.generation) return { kind: 'failed', reason: 'capability_rejected' };
        if (await call<AuthorityCheck>(current(), 'authorize') !== 'ok') return { kind: 'failed', reason: 'initialization_failed' };
        if (!reservation.activated.includes(activation.operationId)) {
          reservation = { ...reservation, activated: [...reservation.activated, activation.operationId] };
          await writeJson(reservationPath, reservation);
        }
        return { kind: 'ready' };
      },
      async status(deviceId): Promise<DeviceStatus> {
        if (closed) return 'unavailable';
        if (deviceId !== input.deviceId) return 'missing';
        return reservation.activated.length > 0 ? 'ready' : 'incomplete';
      },
    };
    const source: SubscriptionSource = {
      async authorize(options) {
        return closed ? 'unavailable' : abortable(call<AuthorityCheck>(current(), 'authorize'), options?.signal).catch(() => 'unavailable');
      },
      listen(listener) { if (!closed) listeners.add(listener); return () => { listeners.delete(listener); }; },
      async read({ cursor, limit }, options): Promise<SourceRead> {
        if (closed) return { kind: 'unavailable' };
        if (limit < 1 || limit > 100 || !Number.isSafeInteger(limit)) return { kind: 'rejected', code: 'unsupported' };
        try {
          const wire = await abortable(call<BrowserPage>(current(), 'read', cursor, limit), options?.signal);
          // A limited timeline means Synapse dropped older events. Never advance beyond a gap.
          if (wire.limited) return { kind: 'gap' };
          const events: SourceEvent[] = [];
          for (const event of wire.events) {
            // The agent's own encrypted sends are not owner-authored pending work.
            // Skipping them still advances the authenticated Matrix cursor.
            if (event.senderUserId === input.userId) continue;
            const participant = input.participantIdFor(event.senderUserId);
            if (!participant) return { kind: 'rejected', code: 'unsupported' };
            const claimedDevice = (event.senderDeviceId ?? 'unknown') as DeviceId;
            const base = { v: 1 as const, roomId: event.roomId as RoomId, eventId: event.eventId as EventId,
              authorParticipantId: participant, authorDeviceId: claimedDevice };
            if (event.failure !== null || event.body === null || event.senderDeviceId === null) {
              events.push({ kind: 'undecryptable', ref: base, reason: event.failure ?? 'decrypt_failed' });
              continue;
            }
            const canonicalPayload = encodeMessageContent({ v: 1, kind: 'text', body: event.body });
            events.push({ kind: 'decrypted', ref: {
              ...base, contentDigest: `sha256:${createHash('sha256').update(canonicalPayload).digest('hex')}`,
            }, verifiedDeviceId: claimedDevice, canonicalPayload });
          }
          return { kind: 'page', events, nextCursor: wire.nextCursor, caughtUp: wire.events.length < limit };
        } catch (error) {
          const reason = error instanceof Error ? error.message : '';
          return reason.includes('matrix_authority_lost') ? { kind: 'rejected', code: 'authority_lost' } : { kind: 'unavailable' };
        }
      },
    };
    return {
      devices, source, fingerprint: identity.fingerprint,
      send: (clientTxnId, body) => serializeSend(async () => {
        if (!/^[A-Za-z0-9_-]{8,128}$/u.test(clientTxnId) || typeof body !== 'string' || body.length === 0
          || Buffer.byteLength(body) > 64 * 1024) throw new Error('matrix_invalid_send');
        const digest = createHash('sha256').update(body).digest('hex');
        const outgoingPath = fileFor(outgoingDirectory, `${createHash('sha256').update(clientTxnId).digest('hex')}.json`);
        const prior = await readFile(outgoingPath, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        const previous: unknown = prior === null ? null : JSON.parse(prior);
        if (previous !== null && (typeof previous !== 'object' || Array.isArray(previous)
          || !('clientTxnId' in previous) || previous.clientTxnId !== clientTxnId
          || !('digest' in previous) || typeof previous.digest !== 'string'
          || !('eventId' in previous) || (previous.eventId !== null && typeof previous.eventId !== 'string')))
          throw new Error('matrix_outgoing_corrupt');
        if (previous !== null && previous.digest !== digest) throw new Error('matrix_send_conflict');
        if (previous !== null && typeof previous.eventId === 'string') return { eventId: previous.eventId };
        if (previous === null) await writeJson(outgoingPath, { clientTxnId, digest, eventId: null });
        const accepted = await call<{ eventId: string }>(current(), 'send', clientTxnId, body);
        if (typeof accepted.eventId !== 'string' || !accepted.eventId.startsWith('$')) throw new Error('matrix_send_unknown');
        await writeJson(outgoingPath, { clientTxnId, digest, eventId: accepted.eventId });
        return accepted;
      }),
      trustPeer: async (userId, deviceId, expectedEd25519) => call<void>(current(), 'trustPeer', userId, deviceId, expectedEd25519),
      async close() {
        if (closed) return;
        listeners.clear();
        try { await call<void>(current(), 'close'); } catch { /* browser may have stopped */ }
        closed = true;
        await context?.close();
        await new Promise<void>(resolve => server?.close(() => resolve()));
        await lock.close();
        await rm(lockPath, { force: true });
      },
    };
  } catch (error) {
    try { if (page) await call<void>(page, 'close'); } catch { /* ignore during failure cleanup */ }
    await context?.close();
    if (server) await new Promise<void>(resolve => server?.close(() => resolve()));
    await lock.close();
    await rm(lockPath, { force: true });
    throw error;
  }
}
