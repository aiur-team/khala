import { CliError } from '../errors.js';
import { publicConnectResult, validLink, write } from '../runtime.js';
import type { CliCommand } from '../types.js';

export const connectCommand: CliCommand = {
  name: 'connect',
  async run(args, deps) {
    if (args.length !== 1 || !validLink(args[0])) throw new CliError('invalid_link');
    const result = publicConnectResult(await deps.client.connect(args[0]!, deps.signal));
    if (result.kind === 'unavailable') throw new CliError('transport_unavailable');
    if (result.kind === 'refused') { await write(deps.stdout, JSON.stringify({ ok: false, error: result.code }) + '\n'); return 3; }
    await write(deps.stdout, JSON.stringify({ ok: true, binding: result.binding, reused: result.reused }) + '\n');
    return 0;
  },
};
