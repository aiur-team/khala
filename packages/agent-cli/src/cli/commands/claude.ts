import { runClaudeCommand } from '../../composition/claude-command.js';
import { readStdin } from '../runtime.js';
import type { CliCommand } from '../types.js';

export const claudeCommand: CliCommand = {
  name: 'claude',
  run: (args, deps) => runClaudeCommand(args, { ...deps, readStdin }),
};
