import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type ActivationRead, type ActivationRecord, type ActivationResult, type ChannelAccessActivationPorts,
  type ChannelAccessActivationStore, type ChannelAccessExchangeClient, type ChannelAccessRedeemPort, type ExchangeOutcome,
  type ReadinessOutcome, activateChannelAccess, decodeActivationRecord, journalChannelAccessRequest,
} from '@khala/connector/bootstrap/channel-access-activation';
import { type ProofSigner, createProofSigner } from '@khala/connector/bootstrap/proof';
import { ADAPTER_CAPABILITIES } from '@khala/connector/bootstrap/ports';
import {
  INTERNAL_ACTIVE_DESCRIPTOR_FILE, type InternalDescriptor, encodeInternalDescriptor, isGrantedDescriptor,
} from '@khala/contracts/internal/descriptor';
import {
  INTERNAL_CONNECTOR_KEY_FILE, INTERNAL_GRANT_DESCRIPTOR_FILE, type InternalDiscoveryDescriptor, parseInternalConnectorKey,
} from '@khala/contracts/internal/discovery-descriptor';
import {
  type AccessRequestOutcome, type GrantExchangeRejection, type StableAgentPrincipal, decodeAccessRequestStatus,
  decodeSessionBinding, sameSessionBinding,
} from '@khala/contracts/messaging/index';
import { acquireProcessLock } from '../cli/inbox.js';
import { plainObject } from '../cli/validation.js';
import { readInternalDescriptor } from './internal.js';

// Finishes an owner-approved channel-access request against the local internal
// server: exchange with a fresh DPoP proof from the discovery `connector-key.json`,
// open the sealed grant, `/activate`, write the returned binding into the agent's own
// `grant.json` and only then acknowledge `/ready`. It drives the connector's activation state
// machine with internal ports, so every step is journaled and resumable: a crash at
// any point resumes by operation ID with the same device and the same binding.
// The server's binding ID is derived from the operation, so a resume never mints a
// second binding, and `grant: null` resumes an activation that already happened.
// That is also how a connected binding survives a launcher restart: capabilities are
// launch-scoped, a resumed launcher's new transport capability reseeds the agent's grant
// file transport-only, and the next activation of the connected operation takes a fresh
// capability for the same binding.
//
// Each agent's grant lives in its own file beside its discovery descriptor, so two
// sessions of one OS user never compete for the launch's single `active.json`. No grant is
// ever copied there: an installed `mcp-serve` entry finds its own session's `grant.json`.
//
// A capability lives only in memory and in the granted descriptor (0600). Nothing here
// writes a grant, capability or recovery key to any output.

export const INTERNAL_CONNECTOR_PATH = '/api/connector/channel-access-requests';
const ACTIVATION_DIRECTORY = 'activation';
const MAX_RESPONSE_BYTES = 32_768;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JOURNAL_BYTES = 8_192;
const GRANT_REJECTIONS: ReadonlySet<string> = new Set<GrantExchangeRejection>([
  'closed', 'expired', 'proof_mismatch', 'encryption_key_mismatch', 'wrong_origin', 'wrong_requester', 'wrong_generation',
  'wrong_device', 'operation_mismatch', 'key_reuse',
]);

export type InternalActivationOptions = Readonly<{
  /** The agent's discovery `descriptor.json`; `connector-key.json` and the journal live beside it. */
  descriptorPath: string;
  descriptor: InternalDiscoveryDescriptor;
  origin: string;
  operationId: string;
  /**
   * The granted descriptor to write instead of the agent's `grant.json`. It must already
   * hold the launch's transport descriptor. The Claude session route keeps one per session.
   */
  grantPath?: string | undefined;
  /** `repair_required` from the service: resume the same operation with its device and recovery key. */
  repair?: boolean;
  fetch?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam: replaces the connector ports' sleep and clock. */
  sleep?: (ms: number) => Promise<void>;
  clock?: (() => number) | undefined;
}>;

export type InternalActivationOutcome =
  | 'connected' | 'connecting' | 'repair_required' | 'denied' | 'expired' | 'revoked' | 'unavailable';

/**
 * The private state root beside the discovery descriptor: the agent's own granted
 * descriptor lives there, and the launch's stable `active.json` two levels above it.
 */
export function activationPaths(descriptorPath: string) {
  const directory = path.dirname(descriptorPath);
  return {
    directory,
    keyFile: path.join(directory, INTERNAL_CONNECTOR_KEY_FILE),
    journalDirectory: path.join(directory, ACTIVATION_DIRECTORY),
    grantPath: path.join(directory, INTERNAL_GRANT_DESCRIPTOR_FILE),
    launchPath: path.resolve(directory, '..', '..', INTERNAL_ACTIVE_DESCRIPTOR_FILE),
  };
}

/** Runs one journaled activation of `operationId` as far as it goes. Never throws. */
export async function activateInternalAccess(options: InternalActivationOptions): Promise<InternalActivationOutcome> {
  const derived = activationPaths(options.descriptorPath);
  const paths = options.grantPath === undefined ? derived : { ...derived, grantPath: options.grantPath };
  const signer = loadSigner(paths.keyFile, options.descriptor, options.clock);
  if (signer === null) return 'unavailable';
  if (options.grantPath === undefined && !seedGrant(paths.grantPath, paths.launchPath)) return 'unavailable';
  let lock: Readonly<{ release(): Promise<void> }>;
  try {
    await ensureDirectory(paths.journalDirectory);
    lock = await acquireProcessLock(path.join(paths.journalDirectory, `${options.operationId}.lock`));
  } catch {
    return 'unavailable';
  }
  try {
    const ports = createPorts(options, paths, signer);
    const journaled = await journalChannelAccessRequest({
      operationId: options.operationId,
      requester: options.descriptor.principal as StableAgentPrincipal,
      origin: options.origin,
      sessionGeneration: options.descriptor.generation,
    }, ports);
    if (journaled !== 'journaled') return 'unavailable';
    const restored = await restoreConnected(options.operationId, ports, paths.grantPath);
    if (restored !== null) return restored;
    const result = await activateChannelAccess(options.operationId, ports, {
      repair: options.repair === true, signal: options.signal,
    });
    return outcomeOf(result);
  } catch {
    return 'unavailable';
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/**
 * A connected operation whose descriptor holds no grant lost its launch-scoped capability
 * to a restart. Resume the same binding by operation ID, without a grant, and write the
 * fresh capability. The journal stays `connected`: readiness was acknowledged once. Null
 * leaves every other case to the activation state machine.
 */
async function restoreConnected(
  operationId: string, ports: ChannelAccessActivationPorts, grantPath: string,
): Promise<InternalActivationOutcome | null> {
  const loaded = await ports.journal.load(operationId);
  if (loaded.kind !== 'record' || loaded.record.phase !== 'connected') return null;
  const { binding, deviceId, origin } = loaded.record;
  if (binding === null || deviceId === null) return null;
  const held = readInternalDescriptor(grantPath);
  if (!held.ok) return 'unavailable';
  if (isGrantedDescriptor(held.value)) {
    // Another grant holds the descriptor: leave both it and this journal untouched.
    return held.value.bindingId === binding.bindingId ? null : 'unavailable';
  }
  const redeemed = await ports.redeem.resume({ operationId, deviceId, origin, bindingId: binding.bindingId });
  // A binding Stop revoked is never resumed.
  if (redeemed.kind === 'refused') return redeemed.code === 'binding_revoked' ? 'revoked' : 'unavailable';
  if (redeemed.kind !== 'admitted' || !sameSessionBinding(redeemed.binding, binding)
    || redeemed.capability.bindingId !== binding.bindingId) return 'unavailable';
  const written = await ports.devices.activate({ deviceId, binding, capability: redeemed.capability, operationId });
  return written.kind === 'ready' ? 'connected' : 'unavailable';
}

function outcomeOf(result: ActivationResult): InternalActivationOutcome {
  switch (result.kind) {
    case 'connected': return 'connected';
    case 'pending': return 'connecting';
    case 'repair_required': return 'repair_required';
    case 'closed': return result.outcome === 'closed' ? 'revoked' : result.outcome;
    default: return 'unavailable';
  }
}

function loadSigner(keyFile: string, descriptor: InternalDiscoveryDescriptor, clock: (() => number) | undefined): ProofSigner | null {
  const text = readOwnerFile(keyFile, 1_024);
  if (text === null) return null;
  const key = parseInternalConnectorKey(text);
  // A key from another principal or generation is never used to sign for this one.
  if (!key.ok || key.value.principal !== descriptor.principal || key.value.generation !== descriptor.generation) return null;
  try {
    return createProofSigner(createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key.value.publicKey, d: key.value.privateKey }, format: 'jwk',
    }), clock);
  } catch {
    return null;
  }
}

function createPorts(
  options: InternalActivationOptions, paths: ReturnType<typeof activationPaths>, signer: ProofSigner,
): ChannelAccessActivationPorts {
  const transport = options.fetch ?? fetch;
  const { descriptor, origin, operationId } = options;
  const journal = createFileJournal(paths.journalDirectory);
  // The server reports the channel with the binding; the capability record has no field for it.
  let channelId: string | null = null;

  async function connectorCall(
    action: 'exchange' | 'activate' | 'ready', body: unknown,
  ): Promise<Readonly<{ status: number; body: unknown }> | null> {
    const target = `${origin}${INTERNAL_CONNECTOR_PATH}/${encodeURIComponent(operationId)}/${action}`;
    let response: Response;
    try {
      response = await transport(target, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${descriptor.discoveryCapability}`,
          // A fresh single-use proof for exactly this request, bound to the capability.
          dpop: signer.proof('POST', target, descriptor.discoveryCapability),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    let parsed: unknown = null;
    try {
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return null;
      if (text.length > 0) parsed = JSON.parse(text);
    } catch {
      // A body lost after the request reached the service reads as unavailable.
      return null;
    }
    return { status: response.status, body: parsed };
  }

  const rejection = (reply: Readonly<{ status: number; body: unknown }>): GrantExchangeRejection | null => {
    if (reply.status !== 409 && reply.status !== 410) return null;
    const body = reply.body;
    if (!plainObject(body) || body.v !== 1 || body.kind !== 'rejected' || typeof body.code !== 'string') return null;
    return GRANT_REJECTIONS.has(body.code) ? body.code as GrantExchangeRejection : null;
  };

  const exchange: ChannelAccessExchangeClient = {
    async exchange(request): Promise<ExchangeOutcome> {
      const reply = await connectorCall('exchange', request);
      if (reply === null) return { kind: 'unavailable' };
      if (reply.status === 200 && reply.body !== null) return { kind: 'sealed', envelope: reply.body };
      const code = rejection(reply);
      return code === null ? { kind: 'unavailable' } : { kind: 'rejected', code };
    },
    async acknowledge(readiness): Promise<ReadinessOutcome> {
      const reply = await connectorCall('ready', readiness);
      if (reply === null) return 'unavailable';
      if (reply.status === 200 && plainObject(reply.body) && reply.body.outcome === 'connected') return 'acknowledged';
      const code = rejection(reply);
      if (code === 'closed' || code === 'expired') return 'closed';
      return code === null ? 'unavailable' : 'rejected';
    },
  };

  async function activateCall(deviceId: string, grant: string | null) {
    const reply = await connectorCall('activate', { v: 1, operationId, deviceId, grant });
    if (reply === null) return { kind: 'outcome_unknown' } as const;
    const code = rejection(reply);
    if (code !== null) {
      return code === 'closed' || code === 'expired'
        ? { kind: 'refused', code: 'binding_revoked' } as const
        : { kind: 'refused', code: 'binding_conflict' } as const;
    }
    const body = reply.body;
    if (reply.status !== 200 || !plainObject(body) || body.v !== 1 || body.operationId !== operationId
      || typeof body.capability !== 'string' || typeof body.channelId !== 'string') {
      return reply.status >= 500 ? { kind: 'unavailable' } as const : { kind: 'outcome_unknown' } as const;
    }
    const binding = decodeSessionBinding(body.binding);
    if (!binding.ok) return { kind: 'refused', code: 'binding_conflict' } as const;
    channelId = body.channelId;
    return {
      kind: 'admitted',
      binding: binding.value,
      // Launch-scoped: the server ends it on Stop or restart, not on a clock.
      capability: {
        token: body.capability, scope: ADAPTER_CAPABILITIES, bindingId: binding.value.bindingId,
        generation: binding.value.generation, expiresAt: Number.MAX_SAFE_INTEGER,
      },
    } as const;
  }

  const redeem: ChannelAccessRedeemPort = {
    redeem: input => activateCall(input.deviceId, input.grant),
    async resume(input) {
      // A descriptor that already holds this binding is the finished write: never call
      // `/activate` again, which would rotate the capability out from under a running client.
      const held = readInternalDescriptor(paths.grantPath);
      if (held.ok && isGrantedDescriptor(held.value) && held.value.bindingId === input.bindingId) {
        const loaded = await journal.load(operationId);
        if (loaded.kind !== 'record' || loaded.record.binding === null || loaded.record.binding.bindingId !== input.bindingId) {
          return { kind: 'unavailable' };
        }
        const { binding } = loaded.record;
        channelId = held.value.channelId;
        return {
          kind: 'admitted',
          binding,
          capability: {
            token: held.value.bindingCapability, scope: ADAPTER_CAPABILITIES, bindingId: binding.bindingId,
            generation: binding.generation, expiresAt: Number.MAX_SAFE_INTEGER,
          },
        };
      }
      return activateCall(input.deviceId, null);
    },
  };

  return {
    journal,
    status: {
      async inspect(input): Promise<AccessRequestOutcome | 'unavailable'> {
        const target = new URL(`/api/agent/channel-access-requests/${encodeURIComponent(input.operationId)}`, input.origin);
        try {
          const response = await transport(target, {
            method: 'GET',
            headers: { accept: 'application/json', authorization: `Bearer ${descriptor.discoveryCapability}` },
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            return 'unavailable';
          }
          const status = decodeAccessRequestStatus(JSON.parse(await response.text()));
          return status.ok && status.value.operationId === input.operationId ? status.value.outcome : 'unavailable';
        } catch {
          return 'unavailable';
        }
      },
    },
    exchange,
    redeem,
    devices: {
      // Derived from the operation, so a crash before the journal write reserves the same device.
      async reserve(id) {
        return { kind: 'reserved', deviceId: `device_${createHash('sha256').update(`khala.internal-device.v1:${id}`).digest('base64url').slice(0, 32)}` };
      },
      async activate(input) {
        if (channelId === null) return { kind: 'failed', reason: 'initialization_failed' };
        return writeBinding(paths.grantPath, {
          channelId, grantRef: operationId, bindingId: input.binding.bindingId, bindingCapability: input.capability.token,
        });
      },
      async status() {
        const loaded = await journal.load(operationId);
        if (loaded.kind !== 'record' || loaded.record.binding === null) return 'missing';
        const held = readInternalDescriptor(paths.grantPath);
        if (!held.ok) return 'unavailable';
        return isGrantedDescriptor(held.value) && held.value.bindingId === loaded.record.binding.bindingId ? 'ready' : 'incomplete';
      },
    },
    // The internal server owns trust: a new binding starts in review, unpaused, and delivery holds otherwise.
    trust: { async initialize() { return { kind: 'initialized', mode: 'review', paused: false }; } },
    signer,
    polling: { baseMs: 250, maxMs: 1_000, maxAttempts: 3 },
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  };
}

/**
 * Seeds the agent's granted descriptor from the launch's transport descriptor. A file from
 * this launch is kept, grant and all, so an agent holds one binding at a time and a resumed
 * `join` finds its finished write. A file from an earlier launch holds a capability that
 * launch's shutdown ended, so it is replaced.
 */
function seedGrant(grantPath: string, launchPath: string): boolean {
  const launch = readInternalDescriptor(launchPath);
  if (!launch.ok) return false;
  const held = readInternalDescriptor(grantPath);
  if (held.ok && held.value.origin === launch.value.origin
    && held.value.transportCapability === launch.value.transportCapability) return true;
  const { v, channelId, origin, transportCapability } = launch.value;
  const text = encodeOrNull({ v, channelId, origin, transportCapability });
  return text !== null && writeDescriptor(grantPath, text);
}

/**
 * Drops the grant of `bindingId` from the agent's granted descriptor once the server no longer
 * holds that binding, as after the owner's Stop, keeping the launch's transport fields. A
 * later approval can then write its own binding; otherwise the revoked grant would refuse it.
 * A descriptor that holds any other binding, or none, is left alone.
 */
export function releaseRevokedGrant(grantPath: string, bindingId: string): boolean {
  const held = readInternalDescriptor(grantPath);
  if (!held.ok || !isGrantedDescriptor(held.value) || held.value.bindingId !== bindingId) return false;
  const { v, channelId, origin, transportCapability } = held.value;
  const text = encodeOrNull({ v, channelId, origin, transportCapability });
  return text !== null && writeDescriptor(grantPath, text);
}

/**
 * Atomically adds `{grantRef, bindingId, bindingCapability}` to the agent's granted
 * descriptor, which takes the grant's channel. It refuses a different live binding, so an
 * approval never replaces the grant the file already holds.
 */
function writeBinding(grantPath: string, grant: Readonly<{
  channelId: string; grantRef: string; bindingId: string; bindingCapability: string;
}>): Readonly<{ kind: 'ready' }> | Readonly<{ kind: 'failed'; reason: 'storage_unavailable' | 'initialization_failed' }> {
  const current = readInternalDescriptor(grantPath);
  if (!current.ok) return { kind: 'failed', reason: 'storage_unavailable' };
  if (isGrantedDescriptor(current.value)) {
    // The same binding is the completed write. Anything else belongs to another grant.
    return current.value.bindingId === grant.bindingId && current.value.channelId === grant.channelId
      ? { kind: 'ready' } : { kind: 'failed', reason: 'initialization_failed' };
  }
  const text = encodeOrNull({
    ...current.value, channelId: grant.channelId,
    grantRef: grant.grantRef, bindingId: grant.bindingId, bindingCapability: grant.bindingCapability,
  });
  if (text === null) return { kind: 'failed', reason: 'initialization_failed' };
  return writeDescriptor(grantPath, text) ? { kind: 'ready' } : { kind: 'failed', reason: 'storage_unavailable' };
}

function encodeOrNull(descriptor: InternalDescriptor): string | null {
  try { return encodeInternalDescriptor(descriptor); } catch { return null; }
}

/** Replaces `file` with `text` as one owner-only 0600 file, fsynced with its directory. */
function writeDescriptor(file: string, text: string): boolean {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(handle, 0o600);
      fs.writeFileSync(handle, text, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* never written, or already renamed */ }
    return false;
  }
}

// One owner-only file per operation: `{v, revision, record, recoveryKey}`. The caller holds
// the operation's process lock, so a read-then-write revision check is enough.
function createFileJournal(directory: string): ChannelAccessActivationStore {
  const fileOf = (operationId: string) => path.join(directory, `${operationId}.json`);

  async function load(operationId: string): Promise<ActivationRead> {
    const text = readOwnerFile(fileOf(operationId), MAX_JOURNAL_BYTES);
    if (text === null) return fs.existsSync(fileOf(operationId)) ? { kind: 'unavailable' } : { kind: 'absent' };
    try {
      const value: unknown = JSON.parse(text);
      if (!plainObject(value) || value.v !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
        return { kind: 'unavailable' };
      }
      const record = decodeActivationRecord(value.record);
      if (record === null || record.operationId !== operationId) return { kind: 'unavailable' };
      const key = value.recoveryKey === null ? null : typeof value.recoveryKey === 'string' ? Buffer.from(value.recoveryKey, 'base64url') : undefined;
      if (key === undefined || (key !== null && key.length !== 32)) return { kind: 'unavailable' };
      return { kind: 'record', record, revision: value.revision as number, recoveryKey: key === null ? null : new Uint8Array(key) };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return {
    load,
    async save(record: ActivationRecord, expectedRevision, key) {
      const current = await load(record.operationId);
      if (current.kind === 'unavailable') return { kind: 'unavailable' };
      if (expectedRevision === null ? current.kind !== 'absent' : current.kind !== 'record' || current.revision !== expectedRevision) {
        return { kind: 'conflict' };
      }
      const held = current.kind === 'record' ? current.recoveryKey : null;
      const next = key.kind === 'set' ? key.privateKey : key.kind === 'clear' ? null : held;
      const revision = (current.kind === 'record' ? current.revision : 0) + 1;
      try {
        await ensureDirectory(directory);
        await writeAtomic(fileOf(record.operationId), `${JSON.stringify({
          v: 1, revision, record, recoveryKey: next === null ? null : Buffer.from(next).toString('base64url'),
        })}\n`);
        return { kind: 'saved', revision };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    async listActive() {
      let names: string[];
      try { names = await fsp.readdir(directory); } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : 'unavailable';
      }
      const active: string[] = [];
      for (const name of names.filter(each => each.endsWith('.json'))) {
        const id = name.slice(0, -'.json'.length);
        const read = await load(id);
        if (read.kind === 'unavailable') return 'unavailable';
        if (read.kind === 'record' && read.record.phase !== 'connected' && read.record.phase !== 'closed') active.push(id);
      }
      return active;
    },
  };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    const handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, file);
  } finally {
    await fsp.unlink(temporary).catch(() => undefined);
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fsp.lstat(directory);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stats.isDirectory() || (uid !== null && stats.uid !== uid) || (stats.mode & 0o077) !== 0) throw new Error('state directory');
}

/** One small regular file only its owner can touch; symlinks are refused. */
function readOwnerFile(file: string, maxBytes: number): string | null {
  let handle: number;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stats = fs.fstatSync(handle);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stats.isFile() || (stats.mode & 0o077) !== 0 || (uid !== null && stats.uid !== uid) || stats.size > maxBytes) return null;
    return fs.readFileSync(handle, 'utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
}
