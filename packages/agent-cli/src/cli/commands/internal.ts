import { runInternal } from '../internal.js';
import type { CliCommand } from '../types.js';

export const internalCommand: CliCommand = {
  name: 'internal',
  run: (args, deps) => runInternal(args, deps),
};
