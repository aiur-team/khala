import type { Readable, Writable } from 'node:stream';
import { CliError } from '../cli/errors.js';
import { MAX_SEND_BYTES } from '../cli/send.js';
import { validIdentifier } from '../cli/validation.js';
import type { ClaudeSessionClient } from './claude-session-http.js';

export const CLAUDE_COMMAND_OPS = ['pull', 'read', 'send', 'status', 'mode', 'pending'] as const;

export type ClaudeCommandDependencies = Readonly<{
  /** Absent until the live local-server composition exists: the command fails closed. */
  claude?: ClaudeSessionClient | undefined;
  stdin: Readable; stdout: Writable; signal?: AbortSignal | undefined;
  readStdin(input: Readable, limit: number): Promise<string>;
}>;

/**
 * `khala claude <op> --session <claude-session-id>`, the entry point Claude hooks and
 * the `/khala` skill call. Hooks use `pull` (never acknowledges) and `pending`; the
 * agent's own calls, `read`, `send`, `status` and `mode`, acknowledge what hooks
 * delivered. The session ID is a selector only; the loopback server authenticates
 * the installation. Output never carries a token.
 */
export async function runClaudeCommand(args: readonly string[], deps: ClaudeCommandDependencies): Promise<number> {
  const [op, flag, sessionId, ...rest] = args;
  if (flag !== '--session' || !validIdentifier(sessionId) || rest.length !== 0) throw new CliError('invalid_arguments');
  if (!(CLAUDE_COMMAND_OPS as readonly unknown[]).includes(op)) throw new CliError('invalid_arguments');
  if (deps.claude === undefined) throw new CliError('transport_unavailable');
  const client = deps.claude;
  let outcome: Readonly<Record<string, unknown>>;
  if (op === 'pull' || op === 'read') {
    const result = await client[op](sessionId, deps.signal);
    if (result.kind === 'batch') { await write(deps.stdout, `${result.text}\n`); return 0; }
    outcome = result;
  } else if (op === 'send') {
    outcome = await client.send(sessionId, await deps.readStdin(deps.stdin, MAX_SEND_BYTES), deps.signal);
  } else if (op === 'status') {
    outcome = await client.status(sessionId, deps.signal);
  } else if (op === 'mode') {
    outcome = await client.mode(sessionId, deps.signal);
  } else {
    outcome = await client.pending(sessionId, deps.signal);
  }
  const ok = outcome.kind !== 'refused' && outcome.kind !== 'outcome_unknown';
  await write(deps.stdout, `${JSON.stringify({ ok, ...outcome })}\n`);
  return ok ? 0 : outcome.kind === 'refused' ? 3 : 4;
}

function write(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()));
}
