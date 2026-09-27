import { CliError } from '../errors.js';
import { validLink, write } from '../runtime.js';
import { ConnectService } from '../connect.js';
import type { CliCommand } from '../types.js';

export const connectCommand: CliCommand = {
  name: 'connect',
  async run(args, deps) {
    if (args.length !== 1 || !validLink(args[0])) throw new CliError('invalid_link');
    const result = await new ConnectService(deps.client).connect(args[0], deps.signal);
    if (!result.ok && result.error === 'unavailable') throw new CliError('transport_unavailable');
    if (!result.ok) { await write(deps.stdout, JSON.stringify(result) + '\n'); return 3; }
    await write(deps.stdout, JSON.stringify(result) + '\n');
    return 0;
  },
};
