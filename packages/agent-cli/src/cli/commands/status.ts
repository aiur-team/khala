import { setupResultExitCode } from '../../setup/plan.js';
import { CliError } from '../errors.js';
import { publicStatus, write } from '../runtime.js';
import type { CliCommand } from '../types.js';
import { runSetup, setupService } from './setup.js';

export const statusCommand: CliCommand = {
  name: 'status',
  async run(args, deps) {
    const check = args.length === 1 && args[0] === '--check';
    if (args.length !== 0 && !check) throw new CliError('invalid_arguments');
    const current = publicStatus(await deps.client.status(deps.signal));
    let inbox = null;
    if (current.binding) inbox = await (await deps.inbox(current.binding.bindingId, current.binding.generation)).status();
    // Configuration is additive: the connection fields above keep their shape and meaning.
    const service = check || deps.setup !== undefined ? setupService(deps) : null;
    const configuration = service === null ? undefined : await runSetup(() => service.configuration());
    await write(deps.stdout, JSON.stringify({ ...current, inbox, configuration }) + '\n');
    // Bare status stays informational; only `--check` gates on configuration readiness.
    return configuration === undefined ? 0 : setupResultExitCode(configuration, check);
  },
};
