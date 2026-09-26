import path from 'node:path';
import { CliError } from './errors.js';

export const INTERNAL_DESCRIPTOR_OPTION = '--internal-descriptor';

/** Commands that run against the descriptor-selected local client. */
export const INTERNAL_CLIENT_COMMANDS: ReadonlySet<string> = new Set(['status', 'send', 'read', 'listen', 'mcp-serve', 'join']);

/**
 * Splits a leading `--internal-descriptor <absolute-path>` from argv. The path
 * is the only internal-mode input a caller (or an installed MCP entry) supplies;
 * the port and capabilities are read from that file at call time.
 */
export function extractInternalDescriptor(argv: readonly string[]): Readonly<{
  descriptorPath: string | null;
  argv: readonly string[];
}> {
  if (argv[0] !== INTERNAL_DESCRIPTOR_OPTION) {
    if (argv.includes(INTERNAL_DESCRIPTOR_OPTION)) throw new CliError('invalid_arguments');
    return { descriptorPath: null, argv };
  }
  const descriptorPath = argv[1];
  const rest = argv.slice(2);
  if (typeof descriptorPath !== 'string' || !path.isAbsolute(descriptorPath) || descriptorPath.includes('\0')
    || rest.includes(INTERNAL_DESCRIPTOR_OPTION)) {
    throw new CliError('invalid_arguments');
  }
  return { descriptorPath, argv: rest };
}
