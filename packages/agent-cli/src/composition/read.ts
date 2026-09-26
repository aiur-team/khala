import type { BindingId, SessionBinding } from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import type { InboxBatch, InboxConsumer } from '../cli/inbox.js';
import { validBindingArgument } from '../cli/validation.js';

export type ReadInput = Readonly<{
  bindingId: BindingId | null;
  acknowledgeToken?: string;
  maxBytes: number;
  offerScope?: string;
}>;

export type ReadResult =
  | Readonly<{ kind: 'batch'; batch: InboxBatch }>
  | Readonly<{ kind: 'empty' }>;

export type ReadOperationOptions = Readonly<{
  heldBinding: SessionBinding;
  consumer: InboxConsumer;
  currentBinding: () => Promise<SessionBinding | null>;
}>;

/**
 * Selects one ordered batch through an injected consumer. Consumer ownership
 * stays with the adapter so CLI and MCP can use their appropriate lifetimes.
 */
export class ReadOperation {
  readonly #heldBinding: SessionBinding;
  readonly #consumer: InboxConsumer;
  readonly #currentBinding: () => Promise<SessionBinding | null>;

  constructor(options: ReadOperationOptions) {
    this.#heldBinding = options.heldBinding;
    this.#consumer = options.consumer;
    this.#currentBinding = options.currentBinding;
  }

  async read(input: ReadInput): Promise<ReadResult> {
    if (!(input.bindingId === null || validBindingArgument(input.bindingId))
      || !(input.acknowledgeToken === undefined || typeof input.acknowledgeToken === 'string')
      || !(input.offerScope === undefined || typeof input.offerScope === 'string')
      || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new CliError('invalid_arguments');
    }
    if (input.bindingId !== null && input.bindingId !== this.#heldBinding.bindingId) {
      throw new CliError('binding_not_held');
    }
    if (!sameHeldBinding(this.#heldBinding, await this.#currentBinding())) {
      throw new CliError('binding_not_held');
    }

    const batch = await this.#consumer.readBatch({
      maxBytes: input.maxBytes,
      ...(input.acknowledgeToken === undefined ? {} : { acknowledgeToken: input.acknowledgeToken }),
      ...(input.offerScope === undefined ? {} : { offerScope: input.offerScope }),
    });

    if (!sameHeldBinding(this.#heldBinding, await this.#currentBinding())) {
      throw new CliError('binding_not_held');
    }
    return batch === null ? { kind: 'empty' } : { kind: 'batch', batch };
  }
}

// Preserve the complete SessionBinding identity without a runtime import from
// the source-only contracts workspace package in the packaged CLI.
export function sameHeldBinding(a: SessionBinding, b: SessionBinding | null): boolean {
  return b !== null
    && a.v === b.v
    && a.bindingId === b.bindingId
    && a.ownerId === b.ownerId
    && a.agentParticipantId === b.agentParticipantId
    && a.deviceId === b.deviceId
    && a.harness === b.harness
    && a.sessionId === b.sessionId
    && a.generation === b.generation;
}
