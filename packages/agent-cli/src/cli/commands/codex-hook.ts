import { runCodexHook } from '../../codex/hook.js';
import { CliError } from '../errors.js';
import { publicStatus } from '../runtime.js';
import type { CliCommand } from '../types.js';

/** The byte-stable native Codex hook handler; see `src/codex/hook.ts`. */
export const codexHookCommand: CliCommand = {
  name: 'codex-hook',
  async run(args, deps) {
    if (args.length !== 0) throw new CliError('invalid_arguments');
    const currentBinding = async () => {
      const latest = publicStatus(await deps.client.status(deps.signal));
      return latest.connected ? latest.binding : null;
    };
    const stored = deps.client.storedSessionId;
    await runCodexHook({
      stdin: deps.stdin, stdout: deps.stdout, stderr: deps.stderr, inbox: deps.inbox, signal: deps.signal, currentBinding,
      ...(stored ? { storedSessionId: (sessionId: string) => stored('codex', sessionId) } : {}),
      listeningMode: async () => deps.client.listeningMode ? deps.client.listeningMode(deps.signal) : null,
    });
    return 0;
  },
};
