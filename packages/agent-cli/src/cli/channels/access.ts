// Shared by `khala channels request-access`, `khala channels access-status`, and
// their MCP tools, so both surfaces print the identical strictly decoded status.
// The service never retries and never mints an operation ID after a failure: a
// lost or unavailable response is reported under the ID the caller already holds.

import { createHash } from 'node:crypto';
import { MAX_CHANNEL_URL_BYTES, decodeAccessRequestStatus } from '@khala/contracts/messaging/index';
import type { AgentClientPort } from '../types.js';
import { plainObject, validIdentifier } from '../validation.js';
import {
  ACCESS_REFUSAL_CODES, type AccessNextAction, type AccessOutput, type AccessRefusalCode, type AccessRequestInput,
  type AccessStatusInput, type AccessTarget, type ChannelAccessResult,
} from './types.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ChannelAccessService {
  readonly #client: AgentClientPort;
  constructor(client: AgentClientPort) { this.#client = client; }

  async request(input: AccessRequestInput, signal?: AbortSignal): Promise<AccessOutput> {
    const call = this.#client.requestChannelAccess;
    return this.#settle(input.operationId, call === undefined ? null : () => call.call(this.#client, input, signal));
  }

  async status(input: AccessStatusInput, signal?: AbortSignal): Promise<AccessOutput> {
    const call = this.#client.channelAccessStatus;
    return this.#settle(input.operationId, call === undefined ? null : () => call.call(this.#client, input, signal));
  }

  async #settle(operationId: string, call: (() => Promise<ChannelAccessResult>) | null): Promise<AccessOutput> {
    if (call === null) return failure('unavailable', operationId);
    let result: unknown;
    try { result = await call(); } catch { return failure('unavailable', operationId); }
    if (!plainObject(result)) return failure('unavailable', operationId);
    if (result.kind === 'refused' && typeof result.code === 'string'
      && (ACCESS_REFUSAL_CODES as readonly string[]).includes(result.code)) {
      return failure(result.code as AccessRefusalCode, operationId);
    }
    if (result.kind !== 'status') return failure('unavailable', operationId);
    // Anything beyond `v`, `operationId`, and `outcome` fails the closed decoder
    // and is never forwarded; a status for a different operation is unusable.
    const status = decodeAccessRequestStatus(result.status);
    if (!status.ok || status.value.operationId !== operationId) return failure('unavailable', operationId);
    return {
      ok: true, v: 1, operationId, outcome: status.value.outcome, next: nextAction(status.value.outcome),
    };
  }
}

function nextAction(outcome: string): AccessNextAction | null {
  if (outcome === 'repair_required') return 'repair_connector';
  return outcome === 'unavailable' ? 'reuse_operation_id' : null;
}

function failure(error: Extract<AccessOutput, { ok: false }>['error'], operationId: string): AccessOutput {
  return { ok: false, v: 1, error, operationId, next: error === 'unavailable' ? 'reuse_operation_id' : null };
}

/** A canonical-looking channel URL, or an opaque listing reference; `null` is neither. */
export function parseAccessTarget(value: unknown): AccessTarget | null {
  if (!validIdentifier(value)) return null;
  if (!/^https?:\/\//i.test(value)) return { kind: 'listing_ref', listingRef: value };
  if (Buffer.byteLength(value) > MAX_CHANNEL_URL_BYTES) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const safe = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  return safe && url.username === '' && url.password === '' && url.hash === '' && url.search === ''
    ? { kind: 'channel_url', channelUrl: value } : null;
}

export function validOperationArgument(value: unknown): value is string {
  return validIdentifier(value);
}

/** Stable per target, so a retry without `--operation` reuses the same operation ID. */
export function defaultOperationId(target: AccessTarget): string {
  const locator = target.kind === 'listing_ref' ? target.listingRef : target.channelUrl;
  return createHash('sha256')
    .update(JSON.stringify(['khala.agent-cli.channel-access.v1', target.kind, locator]))
    .digest('base64url').slice(0, 32);
}

/** Pending, approved, connecting, and connected are progress; every other outcome needs attention. */
export function accessExitCode(output: AccessOutput): number {
  if (!output.ok) return output.error === 'unavailable' ? 4 : 3;
  if (output.outcome === 'unavailable') return 4;
  return ['pending_owner', 'approved', 'connecting', 'connected'].includes(output.outcome) ? 0 : 3;
}
