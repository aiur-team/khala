import { ListeningModeOperation } from '../../composition/listening-mode.js';
import { modeExitCode, parseModeArguments, renderModeOutput } from '../mode.js';
import { write } from '../runtime.js';
import type { CliCommand } from '../types.js';

export const modeCommand: CliCommand = {
  name: 'mode',
  async run(args, deps) {
    const input = parseModeArguments(args);
    const operation = new ListeningModeOperation({ application: deps.listeningMode ?? null });
    const outcome = input.action === 'get' ? await operation.get() : await operation.set(input.request);
    await write(deps.stdout, renderModeOutput(outcome) + '\n');
    return modeExitCode(outcome);
  },
};
