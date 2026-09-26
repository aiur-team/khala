import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { BatchInbox } from '../inbox.js';
import { isClaudeMcpEntry, runClaudeMcpServer } from '../../composition/claude-mcp.js';
import { deliveringInbox, type DeliveringInbox } from '../../composition/delivering-inbox.js';
import { ListeningModeOperation } from '../../composition/listening-mode.js';
import { ReadOperation, sameHeldBinding } from '../../composition/read.js';
import { type SessionGrants, harnessSessionFromMeta } from '../../composition/session-grant.js';
import {
  postprocessMcpResult, postprocessPreselectedMcpResult, type McpPostprocessSuppression,
} from '../../mcp/result-postprocessor.js';
import { type McpCallCollaborators, runMcpServer } from '../../mcp/server.js';
import { callScopedConsumer } from '../call-consumer.js';
import { composeChannelTools } from '../../mcp/channels/tools.js';
import { PairingService } from '../pair.js';
import { CliError } from '../errors.js';
import { publicStatus } from '../runtime.js';
import { SendService } from '../send.js';
import type { AgentClientPort, CliCommand, CliDependencies } from '../types.js';

export const mcpServeCommand: CliCommand = {
  name: 'mcp-serve',
  async run(args, deps) {
    if (args.length !== 0) throw new CliError('invalid_arguments');
    if (isClaudeMcpEntry(deps.env)) {
      await runClaudeMcpServer({ claude: deps.claude, channels: composeChannelTools(deps.client), env: deps.env ?? {}, input: deps.stdin, output: deps.stdout, signal: deps.signal });
      return 0;
    }
    if (deps.sessionGrants !== undefined) {
      await runSessionMcpServer(deps, deps.sessionGrants);
      return 0;
    }
    const current = publicStatus(await deps.client.status(deps.signal));
    if (!current.connected || current.binding === null) throw new CliError('not_connected');
    await runMcpServer({
      input: deps.stdin,
      output: deps.stdout,
      ...await boundCollaborators(deps, deps.client, deps.inbox, current.binding),
      signal: deps.signal,
    });
    return 0;
  },
};

/**
 * The installed entry's server: every tool call runs as the session its `_meta` names,
 * through that session's own `grant.json`, and a call naming no session, or a session
 * holding no binding, is refused `not_connected`. Each session's client and delivery
 * open once and stop with the server.
 */
async function runSessionMcpServer(deps: CliDependencies, grants: SessionGrants): Promise<void> {
  if (!deps.internalClient || !deps.internalDelivery) throw new CliError('internal_unavailable');
  const { internalClient, internalDelivery } = deps;
  type Routed = { client: AgentClientPort; delivering: DeliveringInbox; bound: { binding: SessionBinding; collaborators: McpCallCollaborators } | null };
  const sessions = new Map<string, Routed>();
  try {
    await runMcpServer({
      input: deps.stdin,
      output: deps.stdout,
      signal: deps.signal,
      async route(meta) {
        const session = harnessSessionFromMeta(meta);
        if (session === null) return null;
        const grantPath = grants(session);
        let routed = sessions.get(grantPath);
        if (routed === undefined) {
          const client = await internalClient(grantPath);
          const delivering = deliveringInbox(deps.inbox, await internalDelivery(grantPath), deps.signal ? { signal: deps.signal } : {});
          routed = { client, delivering, bound: null };
          sessions.set(grantPath, routed);
        }
        const current = publicStatus(await routed.client.status(deps.signal));
        if (!current.connected || current.binding === null) return null;
        if (routed.bound === null || !sameHeldBinding(routed.bound.binding, current.binding)) {
          routed.bound = {
            binding: current.binding,
            collaborators: await boundCollaborators(deps, routed.client, routed.delivering.inbox, current.binding),
          };
        }
        return routed.bound.collaborators;
      },
    });
  } finally {
    await Promise.all([...sessions.values()].map(routed => routed.delivering.stop()));
  }
}

/** Every tool collaborator for one held binding generation of `client`. */
async function boundCollaborators(
  deps: CliDependencies,
  client: AgentClientPort,
  openInbox: (bindingId: string, generation: number) => Promise<BatchInbox>,
  heldBinding: SessionBinding,
): Promise<McpCallCollaborators> {
  const inbox = await openInbox(heldBinding.bindingId, heldBinding.generation);
  // Hold the listener lock per call, not for the server lifetime, so the harness's
  // native hooks and explicit reads for this binding can pull between tool calls.
  const consumer = callScopedConsumer(inbox, { signal: deps.signal, explicitRead: true });
  const currentBinding = async () => {
    const latest = publicStatus(await client.status(deps.signal));
    return latest.connected ? latest.binding : null;
  };
  // Suppressed batches fail open to the plain tool result; report the
  // content-free stage and code so the operator can see why nothing arrived.
  const onSuppressed = (suppression: McpPostprocessSuppression) => {
    deps.stderr.write(JSON.stringify({ ok: false, warning: 'batch_suppressed', ...suppression }) + '\n');
  };
  return {
    send: new SendService(client),
    read: new ReadOperation({ heldBinding, consumer, currentBinding }),
    // A routed session's mode control is its own descriptor's binding, as under `--internal-descriptor`.
    listeningMode: new ListeningModeOperation({ application: client.listeningModeControl ?? deps.listeningMode ?? null }),
    channels: composeChannelTools(client),
    pair: new PairingService(client),
    postprocessResult: input => postprocessMcpResult({
      ...input,
      consumer,
      isCurrentBinding: async () => sameHeldBinding(heldBinding, await currentBinding()),
      onSuppressed,
    }),
    postprocessReadResult: input => postprocessPreselectedMcpResult({
      ...input,
      isCurrentBinding: async () => sameHeldBinding(heldBinding, await currentBinding()),
      onSuppressed,
    }),
  };
}
