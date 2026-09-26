import { ReadOperation } from '../../composition/read.js';
import { acquireListenerWithin } from '../call-consumer.js';
import { CliError } from '../errors.js';
import { parseReadArguments, renderReadOutput } from '../read.js';
import { publicStatus, write } from '../runtime.js';
import { MAX_SEND_BYTES } from '../send.js';
import type { CliCommand } from '../types.js';

export const readCommand: CliCommand = {
  name: 'read',
  async run(args, deps) {
    const input = parseReadArguments(args);
    const current = publicStatus(await deps.client.status(deps.signal));
    if (!current.connected || current.binding === null) throw new CliError('not_connected');
    const heldBinding = current.binding;
    if (input.bindingId !== null && input.bindingId !== heldBinding.bindingId) {
      throw new CliError('binding_not_held');
    }

    const inbox = await deps.inbox(heldBinding.bindingId, heldBinding.generation);
    const consumer = await acquireListenerWithin(inbox, { signal: deps.signal });
    try {
      const operation = new ReadOperation({
        heldBinding,
        consumer,
        currentBinding: async () => {
          const latest = publicStatus(await deps.client.status(deps.signal));
          return latest.connected ? latest.binding : null;
        },
      });
      const result = await operation.read({ ...input, maxBytes: MAX_SEND_BYTES });
      await write(deps.stdout, renderReadOutput(result) + '\n');
    } finally {
      await consumer.release();
    }
    return 0;
  },
};
