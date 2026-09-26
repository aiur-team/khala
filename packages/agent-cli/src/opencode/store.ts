// Durable OpenCode bridge state for one binding generation: the exact bound session,
// the one in-flight request and its outcome, and the steer envelopes to re-apply. It
// holds no cursor, lease, acknowledgement or release-ID dedupe; those stay Khala's.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import { plainObject, validIdentifier } from '../cli/validation.js';
import { parseOpenCodeEnvelope } from './envelope.js';

/** The session tuple one binding generation is admitted for, recorded on first observation. */
export type OpenCodeBoundSession = Readonly<{
  sessionID: string;
  directory: string;
  opencodeVersion: string;
  providerID: string;
  modelID: string;
}>;

export const OPENCODE_REQUEST_ROUTES = ['steer', 'idle_prompt', 'tool_result'] as const;
/**
 * `marked`: `tool.execute.after` took the batch for the next transform. `submitting`:
 * persisted before `promptAsync`. `delivered`: the transform applied, OpenCode stored the
 * prompt, or a Khala tool result carried it — a queued claim only. `uncertain`:
 * `outcome_unknown`, blocked for a human.
 */
export const OPENCODE_REQUEST_PHASES = ['marked', 'submitting', 'delivered', 'uncertain'] as const;

export type OpenCodeRequest = Readonly<{
  token: string;
  route: (typeof OPENCODE_REQUEST_ROUTES)[number];
  phase: (typeof OPENCODE_REQUEST_PHASES)[number];
  /** The OpenCode user message that stored the prompt, once reconciled. */
  messageID: string | null;
}>;

/** A steer envelope placed by the transform; re-applied after `anchorMessageID` on later model calls. */
export type OpenCodeSteerRecord = Readonly<{ token: string; anchorMessageID: string; envelope: string }>;

export const OPENCODE_DEGRADED_REASONS = [
  'session_missing', 'version_drift', 'model_drift', 'directory_drift', 'envelope_too_large', 'prompt_rejected',
] as const;
export type OpenCodeDegradedReason = (typeof OPENCODE_DEGRADED_REASONS)[number];

export type OpenCodeBridgeState = Readonly<{
  v: 1;
  bindingId: BindingId;
  generation: number;
  session: OpenCodeBoundSession | null;
  degraded: OpenCodeDegradedReason | null;
  request: OpenCodeRequest | null;
  steer: readonly OpenCodeSteerRecord[];
}>;

export interface OpenCodeBridgeStore {
  read(): Promise<OpenCodeBridgeState>;
  write(state: OpenCodeBridgeState): Promise<void>;
}

/** Steer envelopes kept for re-apply; older ones fall out of later model context. */
export const OPENCODE_MAX_STEER_RECORDS = 16;

export function initialBridgeState(bindingId: BindingId, generation: number): OpenCodeBridgeState {
  return { v: 1, bindingId, generation, session: null, degraded: null, request: null, steer: [] };
}

export type OpenBridgeStoreOptions = Readonly<{ stateDirectory: string; bindingId: BindingId; generation: number }>;

/** A 0600 JSON file per binding generation under `<state>/opencode/`, replaced atomically. */
export async function openOpenCodeBridgeStore(options: OpenBridgeStoreOptions): Promise<OpenCodeBridgeStore> {
  if (!path.isAbsolute(options.stateDirectory) || !validIdentifier(options.bindingId)
    || !Number.isSafeInteger(options.generation) || options.generation < 0) throw new CliError('invalid_input');
  const directory = path.join(options.stateDirectory, 'opencode');
  await ensurePrivateDirectory(options.stateDirectory);
  await ensurePrivateDirectory(directory);
  const name = createHash('sha256').update(JSON.stringify([options.bindingId, options.generation])).digest('base64url');
  const filename = path.join(directory, `${name}.json`);
  return {
    async read() {
      let text: string;
      try {
        const stat = await fsp.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new CliError('storage_failed');
        text = await fsp.readFile(filename, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialBridgeState(options.bindingId, options.generation);
        if (error instanceof CliError) throw error;
        throw new CliError('storage_failed');
      }
      return decodeBridgeState(text, options.bindingId, options.generation);
    },
    async write(state) {
      if (state.bindingId !== options.bindingId || state.generation !== options.generation) throw new CliError('invalid_input');
      const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
      let handle: fsp.FileHandle | null = null;
      try {
        handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        await handle.writeFile(JSON.stringify(state) + '\n', 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fsp.rename(temporary, filename);
        const directoryHandle = await fsp.open(directory, fs.constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch {
        throw new CliError('storage_failed');
      } finally {
        await handle?.close().catch(() => undefined);
        await fsp.unlink(temporary).catch(() => undefined);
      }
    },
  };
}

/** An in-process store for tests and for callers that supply their own durability. */
export function memoryOpenCodeBridgeStore(bindingId: BindingId, generation: number): OpenCodeBridgeStore {
  let encoded = JSON.stringify(initialBridgeState(bindingId, generation));
  return {
    async read() { return decodeBridgeState(encoded, bindingId, generation); },
    async write(state) { encoded = JSON.stringify(state); },
  };
}

export function decodeBridgeState(text: string, bindingId: BindingId, generation: number): OpenCodeBridgeState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError('storage_failed');
  }
  if (!plainObject(value) || !exactKeys(value, ['v', 'bindingId', 'generation', 'session', 'degraded', 'request', 'steer'])
    || value.v !== 1 || value.bindingId !== bindingId || value.generation !== generation
    || !(value.degraded === null || (OPENCODE_DEGRADED_REASONS as readonly unknown[]).includes(value.degraded))
    || !Array.isArray(value.steer) || value.steer.length > OPENCODE_MAX_STEER_RECORDS) throw new CliError('storage_failed');
  return {
    v: 1,
    bindingId,
    generation,
    session: value.session === null ? null : decodeSession(value.session),
    degraded: value.degraded as OpenCodeDegradedReason | null,
    request: value.request === null ? null : decodeRequest(value.request),
    steer: (value.steer as unknown[]).map(decodeSteer),
  };
}

function decodeSession(value: unknown): OpenCodeBoundSession {
  const keys = ['sessionID', 'directory', 'opencodeVersion', 'providerID', 'modelID'] as const;
  if (!plainObject(value) || !exactKeys(value, keys) || keys.some(key => !validIdentifier(value[key]))) {
    throw new CliError('storage_failed');
  }
  return value as OpenCodeBoundSession;
}

function decodeRequest(value: unknown): OpenCodeRequest {
  if (!plainObject(value) || !exactKeys(value, ['token', 'route', 'phase', 'messageID'])
    || !validIdentifier(value.token)
    || !(OPENCODE_REQUEST_ROUTES as readonly unknown[]).includes(value.route)
    || !(OPENCODE_REQUEST_PHASES as readonly unknown[]).includes(value.phase)
    || !(value.messageID === null || validIdentifier(value.messageID))) throw new CliError('storage_failed');
  return value as OpenCodeRequest;
}

function decodeSteer(value: unknown): OpenCodeSteerRecord {
  if (!plainObject(value) || !exactKeys(value, ['token', 'anchorMessageID', 'envelope'])
    || !validIdentifier(value.token) || !validIdentifier(value.anchorMessageID) || typeof value.envelope !== 'string'
    || parseOpenCodeEnvelope(value.envelope)?.token !== value.token) throw new CliError('storage_failed');
  return value as OpenCodeSteerRecord;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new CliError('storage_failed');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('storage_failed');
  }
}
