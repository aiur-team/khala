import { SetupPathError } from '../../setup/paths.js';
import {
  setupResultExitCode, type LifecycleCommand, type LifecycleOptions, type SetupService,
} from '../../setup/plan.js';
import type { SetupResult, Sha256Digest } from '../../setup/types.js';
import { CliError } from '../errors.js';
import { write } from '../runtime.js';
import type { CliCommand, CliDependencies } from '../types.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Accepts exactly nothing, `--dry-run`, or `--confirm <digest>`; a dry run has no authority to confirm. */
export function parseLifecycleArguments(args: readonly string[]): LifecycleOptions {
  if (args.length === 0) return { dryRun: false, confirm: null };
  if (args.length === 1 && args[0] === '--dry-run') return { dryRun: true, confirm: null };
  if (args.length === 2 && args[0] === '--confirm' && DIGEST.test(args[1]!)) {
    return { dryRun: false, confirm: args[1] as Sha256Digest };
  }
  throw new CliError('invalid_arguments');
}

export function setupService(deps: CliDependencies): SetupService {
  if (deps.setup === undefined) throw new CliError('internal_error');
  return deps.setup;
}

/** Runs a setup call, mapping an invalid HOME/XDG input to an invalid-input invocation failure. */
export async function runSetup(call: () => Promise<SetupResult>): Promise<SetupResult> {
  try { return await call(); }
  catch (error) { throw error instanceof SetupPathError ? new CliError('invalid_input') : error; }
}

function lifecycleCommand(name: LifecycleCommand): CliCommand {
  return {
    name,
    async run(args, deps) {
      const options = parseLifecycleArguments(args);
      const service = setupService(deps);
      const result = await runSetup(() => service.lifecycle(name, options));
      await write(deps.stdout, JSON.stringify(result) + '\n');
      return setupResultExitCode(result);
    },
  };
}

export const setupCommand = lifecycleCommand('setup');
export const removeCommand = lifecycleCommand('remove');
