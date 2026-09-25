import { randomUUID } from 'node:crypto';
import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import { SEND_REFUSAL_CODES, type AgentClientPort, type SendRefusalCode, type SendResult } from './types.js';
import { validIdentifier } from './validation.js';

export const MAX_SEND_BYTES = 65_536;
export class SendService {
  readonly #client: AgentClientPort;
  constructor(client: AgentClientPort) { this.#client = client; }
  async send(
    body: string,
    bindingId: BindingId | null = null,
    clientTxnId = randomUUID(),
    signal?: AbortSignal,
  ): Promise<SendResult> {
    if (!validBody(body) || !/^[A-Za-z0-9_-]{8,128}$/.test(clientTxnId)) throw new CliError('invalid_input');
    try {
      return publicSendResult(await this.#client.send({ bindingId, clientTxnId, body }, signal), clientTxnId);
    } catch {
      return { kind: 'outcome_unknown', clientTxnId };
    }
  }
}
function validBody(body: unknown): body is string {
  return typeof body === 'string' && body.length > 0 && Buffer.byteLength(body) <= MAX_SEND_BYTES && !body.includes('\u0000');
}

function publicSendResult(value: unknown, clientTxnId: string): SendResult {
  if (value === null || typeof value !== 'object') return { kind: 'outcome_unknown', clientTxnId };
  const result = value as Record<string, unknown>;
  if (result.clientTxnId !== clientTxnId) return { kind: 'outcome_unknown', clientTxnId };
  if (result.kind === 'accepted' && (result.eventId === null || validIdentifier(result.eventId))) {
    return { kind: 'accepted', clientTxnId, eventId: result.eventId };
  }
  if (result.kind === 'refused' && typeof result.code === 'string'
    && (SEND_REFUSAL_CODES as readonly string[]).includes(result.code)) {
    return { kind: 'refused', code: result.code as SendRefusalCode, clientTxnId };
  }
  return { kind: 'outcome_unknown', clientTxnId };
}
