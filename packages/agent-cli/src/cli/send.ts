import { randomUUID } from 'node:crypto';
import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import type { AgentClientPort, SendResult } from './types.js';

export const MAX_SEND_BYTES = 65_536;
export class SendService {
  readonly #client: AgentClientPort;
  constructor(client: AgentClientPort) { this.#client = client; }
  async send(body: string, bindingId: BindingId | null = null, clientTxnId = randomUUID()): Promise<SendResult> {
    if (!validBody(body) || !/^[A-Za-z0-9_-]{8,128}$/.test(clientTxnId)) throw new CliError('invalid_input');
    return this.#client.send({ bindingId, clientTxnId, body });
  }
}
function validBody(body: unknown): body is string {
  return typeof body === 'string' && body.length > 0 && Buffer.byteLength(body) <= MAX_SEND_BYTES && !body.includes('\u0000');
}
