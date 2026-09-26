// Shared by `khala channels create`, `khala channels create-status`, and their
// MCP tools, so both surfaces print the identical strictly decoded status. The
// service never retries and never mints an operation ID: a lost or unavailable
// response is reported under the ID the caller already holds, and only the
// caller's own retry (same ID) can reach the workflow again. It only asks; it
// launches no process and claims no channel, binding, grant, or membership.

import { MAX_CHANNEL_TITLE_BYTES, decodeAccessRequestStatus } from '@khala/contracts/messaging/index';
import type { AgentClientPort } from '../../types.js';
import { plainObject, wellFormed } from '../../validation.js';
import { ACCESS_REFUSAL_CODES, type AccessRefusalCode, type ChannelAccessResult } from '../types.js';
import type { CreateNextAction, CreateOutput, CreateRequestInput, CreateStatusInput } from './types.js';

// Same set the contract's title decoder replaces: controls, bidi and zero-width marks.
const UNSAFE_TITLE = /[\u0000-\u001f\u007f-\u009f؜​‎‏‪-‮⁠⁦-⁩﻿]/gu;

/** A bounded, well-formed title with control characters neutralized; `null` when unusable. */
export function parseCreateTitle(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || !wellFormed(value)) return null;
  if (Buffer.byteLength(value) > MAX_CHANNEL_TITLE_BYTES) return null;
  const normalized = value.replace(UNSAFE_TITLE, '�');
  return Buffer.byteLength(normalized) > MAX_CHANNEL_TITLE_BYTES ? null : normalized;
}

export class ChannelCreateService {
  readonly #client: AgentClientPort;
  constructor(client: AgentClientPort) { this.#client = client; }

  async request(input: CreateRequestInput, signal?: AbortSignal): Promise<CreateOutput> {
    const call = this.#client.requestChannelCreate;
    return this.#settle(input.operationId, call === undefined ? null : () => call.call(this.#client, input, signal));
  }

  async status(input: CreateStatusInput, signal?: AbortSignal): Promise<CreateOutput> {
    const call = this.#client.channelCreateStatus;
    return this.#settle(input.operationId, call === undefined ? null : () => call.call(this.#client, input, signal));
  }

  async #settle(operationId: string, call: (() => Promise<ChannelAccessResult>) | null): Promise<CreateOutput> {
    if (call === null) return failure('unavailable', operationId);
    let result: unknown;
    try { result = await call(); } catch { return failure('unavailable', operationId); }    if (!plainObject(result)) return failure('unavailable', operationId);
    if (result.kind === 'refused' && typeof result.code === 'string'
      && (ACCESS_REFUSAL_CODES as readonly string[]).includes(result.code)) {
      return failure(result.code as AccessRefusalCode, operationId);
    }
    if (result.kind !== 'status') return failure('unavailable', operationId);
    // Anything beyond `v`, `operationId`, and `outcome` (a channel ID, a grant) fails
    // the closed decoder and is never forwarded; another operation's status is unusable.
    const status = decodeAccessRequestStatus(result.status);
    if (!status.ok || status.value.operationId !== operationId) return failure('unavailable', operationId);
    return { ok: true, v: 1, operationId, outcome: status.value.outcome, next: nextAction(status.value.outcome) };
  }
}

function nextAction(outcome: string): CreateNextAction | null {
  if (outcome === 'repair_required') return 'repair_connector';
  return outcome === 'unavailable' ? 'reuse_operation_id' : null;
}

function failure(error: Extract<CreateOutput, { ok: false }>['error'], operationId: string): CreateOutput {
  return { ok: false, v: 1, error, operationId, next: error === 'unavailable' ? 'reuse_operation_id' : null };
}

/** Pending, approved, connecting, and connected are progress; every other outcome needs attention. */
export function createExitCode(output: CreateOutput): number {
  if (!output.ok) return output.error === 'unavailable' ? 4 : 3;
  if (output.outcome === 'unavailable') return 4;
  return ['pending_owner', 'approved', 'connecting', 'connected'].includes(output.outcome) ? 0 : 3;
}
