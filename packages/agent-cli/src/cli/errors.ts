import type { CliErrorCode } from './types.js';

export class CliError extends Error {
  readonly code: CliErrorCode;
  constructor(code: CliErrorCode) { super(code); this.name = 'CliError'; this.code = code; }
}
export function cliErrorCode(error: unknown): CliErrorCode {
  return error instanceof CliError ? error.code : 'internal_error';
}
