import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isGrantedDescriptor } from '@khala/contracts/internal/descriptor';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { validIdentifier } from '../cli/validation.js';
import { readInternalDescriptor, type DescriptorRead } from './internal.js';
import { internalSessionDigest } from './internal-session.js';

export const INTERNAL_TURN_END_PATH = '/api/v1/agent/automation-turn-end';

export type InternalTurnEndOptions = Readonly<{
  /** This session's private grant.json, never the launcher's active.json. */
  descriptorPath: string;
  fetch?: typeof globalThis.fetch;
  readDescriptor?: (file: string) => DescriptorRead;
  timeoutMs?: number;
  /** Required for OpenCode: shared private Khala state for the server's exact terminal baseline. */
  stateDirectory?: string;
}>;

const TERMINAL_DIRECTORY = 'opencode-turn-end';
const MAX_MARKER_BYTES = 2048;
type TerminalMarker = Readonly<{
  v: 1; bindingId: string; generation: number; sessionDigest: string; terminalId: string;
}>;

function markerPath(stateDirectory: string, binding: SessionBinding): string | null {
  if (!path.isAbsolute(stateDirectory) || !validIdentifier(binding.bindingId)
    || !Number.isSafeInteger(binding.generation) || binding.generation < 0) return null;
  const key = createHash('sha256').update(JSON.stringify([binding.bindingId, binding.generation])).digest('base64url');
  return path.join(stateDirectory, TERMINAL_DIRECTORY, `${key}.json`);
}

/** The server reads only this private, exact-generation observation as an OpenCode baseline. */
export function readOpenCodeTerminalId(stateDirectory: string, binding: SessionBinding): string | null {
  if (binding.harness !== 'opencode') return null;
  const file = markerPath(stateDirectory, binding);
  if (file === null || fs.constants.O_NOFOLLOW === undefined) return null;
  let handle: number;
  try { handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_MARKER_BYTES
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1);
    const size = fs.readSync(handle, bytes, 0, bytes.length, 0);
    if (size > MAX_MARKER_BYTES) return null;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 5 && record.v === 1 && record.bindingId === binding.bindingId
      && record.generation === binding.generation && record.sessionDigest === binding.sessionId
      && validIdentifier(record.terminalId) ? record.terminalId : null;
  } catch { return null; }
  finally { fs.closeSync(handle); }
}

function writeOpenCodeTerminalId(stateDirectory: string, binding: SessionBinding, sessionId: string, terminalId: string): boolean {
  const file = markerPath(stateDirectory, binding);
  if (file === null) return false;
  const directory = path.dirname(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const marker: TerminalMarker = { v: 1, bindingId: binding.bindingId, generation: binding.generation,
    sessionDigest: internalSessionDigest(binding.harness, sessionId), terminalId };
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.statSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return false;
    fs.writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(temporary); } catch { /* renamed or not created */ } }
}

/**
 * Reports a native terminal boundary to the local server. This is only an input:
 * HTTP success does not prove the event, complete a job, or grant another budget.
 * The server authenticates the current capability and verifies the binding,
 * generation, native event and channel before recording a completion.
 */
export async function sendInternalTurnEnd(
  options: InternalTurnEndOptions, binding: SessionBinding, sessionId: string, terminalId?: string,
): Promise<boolean> {
  if (!validIdentifier(sessionId) || !Number.isSafeInteger(binding.generation) || binding.generation < 0) return false;
  if (terminalId !== undefined && !validIdentifier(terminalId)) return false;
  if (terminalId !== undefined && (binding.harness !== 'opencode' || options.stateDirectory === undefined)) return false;
  // OpenCode's bridge overlays the raw native ID on its server binding; the
  // durable server binding instead stores this exact harness-scoped digest.
  if (binding.sessionId !== sessionId && binding.sessionId !== internalSessionDigest(binding.harness, sessionId)) return false;
  try {
    const descriptor = (options.readDescriptor ?? readInternalDescriptor)(options.descriptorPath);
    if (!descriptor.ok || !isGrantedDescriptor(descriptor.value) || descriptor.value.bindingId !== binding.bindingId) return false;
    if (terminalId !== undefined && !writeOpenCodeTerminalId(options.stateDirectory!, binding, sessionId, terminalId)) return false;
    const { origin, channelId, bindingCapability } = descriptor.value;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const response = await (options.fetch ?? globalThis.fetch)(`${origin}${INTERNAL_TURN_END_PATH}`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${bindingCapability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, sessionId, channelId, ...(terminalId === undefined ? {} : { terminalId }) }), signal: timeout,
    });
    if (response.status !== 200) { await response.body?.cancel(); return false; }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 128) return false;
    const result: unknown = JSON.parse(raw);
    return typeof result === 'object' && result !== null && !Array.isArray(result)
      && Object.keys(result).length === 1 && (result as Record<string, unknown>).v === 1;
  } catch { return false; }
}
