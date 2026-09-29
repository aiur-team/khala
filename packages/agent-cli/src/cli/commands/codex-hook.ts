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
    const io = { stdin: deps.stdin, stdout: deps.stdout, stderr: deps.stderr, signal: deps.signal,
      ...(deps.codexBoundary ? { onBoundary: deps.codexBoundary } : {}) };
    if (deps.sessionGrants === undefined) {
      await runCodexHook({ ...io, ...hookPorts(deps, deps.client, deps.inbox) });
      return 0;
    }
    // The installed hook serves every Codex session of this user: each invocation acts
    // only as the session its input names, through that session's own `grant.json`.
    const delivering: DeliveringInbox[] = [];
    const hosted: Array<{ close(): Promise<void> }> = [];
    try {
      await runCodexHook({ ...io, session: sessionId => sessionPorts(deps, deps.sessionGrants!, sessionId, delivering, hosted) });
    } finally {
      await Promise.all(delivering.map(each => each.stop()));
      await Promise.all(hosted.map(each => each.close()));
    }
    return 0;
  },
};

async function sessionPorts(
  deps: CliDependencies, grants: SessionGrants, sessionId: string, delivering: DeliveringInbox[],
  hosted: Array<{ close(): Promise<void> }>,
): Promise<CodexHookPorts | null> {
  if (deps.internalClient && deps.internalDelivery) {
    const grantPath = grants({ harness: CODEX_HARNESS, sessionId });
    const client = await deps.internalClient(grantPath);
    if (publicStatus(await client.status(deps.signal)).connected) {
      const inbox = deliveringInbox(deps.inbox, await deps.internalDelivery(grantPath), deps.signal ? { signal: deps.signal } : {});
      delivering.push(inbox);
      return hookPorts(deps, client, inbox.inbox);
    }
  }
  if (!deps.hostedSession) return null;
  if (deps.hostedBindingPresent && !await deps.hostedBindingPresent({ harness: CODEX_HARNESS, sessionId })) return null;
  const opened = await deps.hostedSession({ harness: CODEX_HARNESS, sessionId });
  hosted.push(opened);
  // An unbound or policy-unconfigured hosted session cannot turn a global hook
  // into a release pull. The hook rechecks the exact binding and mode at output.
  const latest = publicStatus(await opened.client.status(deps.signal));
  const storedSessionId = opened.client.storedSessionId?.(CODEX_HARNESS, sessionId) ?? sessionId;
  if (!latest.connected || latest.binding === null || ![CODEX_HARNESS, 'proof-key'].includes(latest.binding.harness)
    || latest.binding.sessionId !== storedSessionId || !opened.client.listeningMode) return null;
  const mode = await opened.client.listeningMode(deps.signal);
  if (mode.bindingId !== latest.binding.bindingId || mode.generation !== latest.binding.generation
    || mode.effective === null) return null;
  return hookPorts(deps, opened.client, opened.inbox);
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
