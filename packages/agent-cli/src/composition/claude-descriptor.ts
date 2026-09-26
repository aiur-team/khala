import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { plainObject, validIdentifier } from '../cli/validation.js';

/** internal-core's `active.json` is small; anything larger is refused unread. */
export const MAX_RUNTIME_DESCRIPTOR_BYTES = 4096;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The loopback origin and installation credential, resolved for one invocation only. */
export type RuntimeTarget = Readonly<{ origin: string; credential: string }>;

export type RuntimeDescriptorFailure = 'descriptor_missing' | 'descriptor_insecure' | 'descriptor_malformed';

export type RuntimeDescriptorResult =
  | Readonly<{ ok: true; target: RuntimeTarget }>
  | Readonly<{ ok: false; code: RuntimeDescriptorFailure }>;

/**
 * Reads the owner-only runtime descriptor that the local Khala server rewrites on
 * every launch. Callers invoke this per operation and never cache or persist the
 * result, so rotation takes effect on the next call. Failures carry only a code:
 * no path, port, credential, or parse detail leaves this function.
 */
export async function readRuntimeDescriptor(path: string): Promise<RuntimeDescriptorResult> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === 'ENOENT' ? 'descriptor_missing' : 'descriptor_insecure' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      return { ok: false, code: 'descriptor_insecure' };
    }
    if (info.size > MAX_RUNTIME_DESCRIPTOR_BYTES) return { ok: false, code: 'descriptor_malformed' };
    const buffer = Buffer.alloc(MAX_RUNTIME_DESCRIPTOR_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > MAX_RUNTIME_DESCRIPTOR_BYTES) return { ok: false, code: 'descriptor_malformed' };
    const target = decodeRuntimeDescriptor(buffer.subarray(0, bytesRead));
    return target === null ? { ok: false, code: 'descriptor_malformed' } : { ok: true, target };
  } catch {
    return { ok: false, code: 'descriptor_malformed' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// internal-core.md's descriptor: `{v, channelId, origin, transportCapability}`,
// later extended with binding fields this adapter does not use.
function decodeRuntimeDescriptor(bytes: Buffer): RuntimeTarget | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!plainObject(value) || value.v !== 1 || !validIdentifier(value.channelId)
    || typeof value.origin !== 'string' || typeof value.transportCapability !== 'string'
    || !CREDENTIAL_PATTERN.test(value.transportCapability)) return null;
  const origin = loopbackOrigin(value.origin);
  return origin === null ? null : { origin, credential: value.transportCapability };
}

function loopbackOrigin(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1
    || url.origin !== value) return null;
  return url.origin;
}
