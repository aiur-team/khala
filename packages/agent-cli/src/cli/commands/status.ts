import { CliError } from '../errors.js';
import { publicStatus, write } from '../runtime.js';
import type { CliCommand } from '../types.js';

export const statusCommand: CliCommand = {
  name: 'status',
  async run(args, deps) {
    if (args.length !== 0) throw new CliError('invalid_arguments');
    const current = publicStatus(await deps.client.status(deps.signal));
    let inbox = null;
    if (current.binding) inbox = await (await deps.inbox(current.binding.bindingId, current.binding.generation)).status();
    await write(deps.stdout, JSON.stringify({ ...current, inbox }) + '\n');
    return 0;
  },
};
