import type { ListeningMode } from '@khala/contracts/delivery/index';
import {
  LISTENING_MODES, type ListeningModeOutcome, type ListeningModeSetRequest,
} from '../composition/listening-mode.js';
import { CliError } from './errors.js';

export type ModeArguments =
  | Readonly<{ action: 'get' }>
  | Readonly<{ action: 'set'; request: ListeningModeSetRequest }>;

/** `mode get` or `mode set <steer|sync|async> --expected-version <n>`; no target flags exist. */
export function parseModeArguments(args: readonly string[]): ModeArguments {
  const [action, ...rest] = args;
  if (action === 'get' && rest.length === 0) return { action: 'get' };
  if (action === 'set' && rest.length === 3 && rest[1] === '--expected-version'
    && /^(0|[1-9][0-9]*)$/.test(rest[2]!)) {
    const expectedVersion = Number(rest[2]);
    const requested = rest[0]!;
    if (Number.isSafeInteger(expectedVersion) && (LISTENING_MODES as readonly string[]).includes(requested)) {
      return { action: 'set', request: { requested: requested as ListeningMode, expectedVersion } };
    }
  }
  throw new CliError('invalid_arguments');
}

export function renderModeOutput(outcome: ListeningModeOutcome): string {
  return JSON.stringify({ ok: outcome.kind === 'view' || outcome.kind === 'applied', ...outcome });
}

export function modeExitCode(outcome: ListeningModeOutcome): number {
  return outcome.kind === 'view' || outcome.kind === 'applied' ? 0 : 3;
}
