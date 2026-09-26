import { CliError } from '../errors.js';
import { optionalBinding, publicStatus, renderInboxItem, waitForSignal, write } from '../runtime.js';
import type { CliCommand } from '../types.js';

export const listenCommand: CliCommand = {
  name: 'listen',
  async run(args, deps) {
    const requested = optionalBinding(args);
    const current = publicStatus(await deps.client.status(deps.signal));
    if (!current.binding || !current.connected) throw new CliError('not_connected');
    if (requested !== null && requested !== current.binding.bindingId) throw new CliError('binding_not_held');
    const inbox = await deps.inbox(current.binding.bindingId, current.binding.generation);
    const lock = await inbox.acquireListener();
    try {
      let idleDelay = 50;
      while (!deps.signal?.aborted) {
        const item = await inbox.readNext();
        if (item === null) {
          await waitForSignal(deps.signal, idleDelay);
          idleDelay = Math.min(idleDelay * 2, 1_000);
          continue;
        }
        idleDelay = 50;
        await write(deps.stdout, renderInboxItem(item) + '\n');
        await inbox.acknowledge(item);
      }
    } finally { await lock.release(); }
    return 0;
  },
};
