import { type CodexHookPorts, runCodexHook } from '../../codex/hook.js';
import { deliveringInbox, type DeliveringInbox } from '../../composition/delivering-inbox.js';
import { CODEX_HARNESS, type SessionGrants } from '../../composition/session-grant.js';
import { CliError } from '../errors.js';
import { publicStatus } from '../runtime.js';
import type { AgentClientPort, CliCommand, CliDependencies } from '../types.js';

/** The byte-stable native Codex hook handler; see `src/codex/hook.ts`. */
export const codexHookCommand: CliCommand = {
  name: 'codex-hook',
  async run(args, deps) {
    if (args.length !== 0) throw new CliError('invalid_arguments');
    const io = { stdin: deps.stdin, stdout: deps.stdout, stderr: deps.stderr, signal: deps.signal };
    if (deps.sessionGrants === undefined) {
      await runCodexHook({ ...io, ...hookPorts(deps, deps.client, deps.inbox) });
      return 0;
    }
    // The installed hook serves every Codex session of this user: each invocation acts
    // only as the session its input names, through that session's own `grant.json`.
    const delivering: DeliveringInbox[] = [];
    try {
      await runCodexHook({ ...io, session: sessionId => sessionPorts(deps, deps.sessionGrants!, sessionId, delivering) });
    } finally {
      await Promise.all(delivering.map(each => each.stop()));
    }
    return 0;
  },
};

async function sessionPorts(
  deps: CliDependencies, grants: SessionGrants, sessionId: string, delivering: DeliveringInbox[],
): Promise<CodexHookPorts | null> {
  if (!deps.internalClient || !deps.internalDelivery) return null;
  const grantPath = grants({ harness: CODEX_HARNESS, sessionId });
  const client = await deps.internalClient(grantPath);
  const inbox = deliveringInbox(deps.inbox, await deps.internalDelivery(grantPath), deps.signal ? { signal: deps.signal } : {});
  delivering.push(inbox);
  return hookPorts(deps, client, inbox.inbox);
}

function hookPorts(deps: CliDependencies, client: AgentClientPort, inbox: CliDependencies['inbox']): CodexHookPorts {
  const stored = client.storedSessionId;
  return {
    currentBinding: async () => {
      const latest = publicStatus(await client.status(deps.signal));
      return latest.connected ? latest.binding : null;
    },
    ...(stored ? { storedSessionId: (sessionId: string) => stored(CODEX_HARNESS, sessionId) } : {}),
    listeningMode: async () => client.listeningMode ? client.listeningMode(deps.signal) : null,
    inbox,
  };
}
