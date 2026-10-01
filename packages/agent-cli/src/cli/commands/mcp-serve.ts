import type { SessionBinding } from '@khala/contracts/delivery/index';
import { setTimeout as delay } from 'node:timers/promises';
import type { BatchInbox } from '../inbox.js';
import { isClaudeMcpEntry, runClaudeMcpServer, sessionOperationId } from '../../composition/claude-mcp.js';
import { CLAUDE_SESSION_ENV } from '../../composition/claude-agent.js';
import { deliveringInbox, type DeliveringInbox } from '../../composition/delivering-inbox.js';
import { ListeningModeOperation } from '../../composition/listening-mode.js';
import { ReadOperation, sameHeldBinding } from '../../composition/read.js';
import { renderInboxBatchWithoutToken } from '../../mcp/result-postprocessor.js';
import { type SessionGrants, harnessSessionFromMeta } from '../../composition/session-grant.js';
import {
  postprocessMcpResult, postprocessPreselectedMcpResult, type McpPostprocessSuppression,
} from '../../mcp/result-postprocessor.js';
import { type McpCallCollaborators, runMcpServer } from '../../mcp/server.js';
import { callScopedConsumer } from '../call-consumer.js';
import { composeChannelTools } from '../../mcp/channels/tools.js';
import { PairingService } from '../pair.js';
import { ConnectService } from '../connect.js';
import { PAIR_TOOL_NAME } from '../../mcp/pair.js';
import { CONNECT_TOOL_NAME } from '../../mcp/connect.js';
import { CliError } from '../errors.js';
import { publicStatus } from '../runtime.js';
import { SendService } from '../send.js';
import { AGENT_READINESS_ERRORS, type AgentClientPort, type CliCommand, type CliDependencies } from '../types.js';
import { validIdentifier } from '../validation.js';

export const mcpServeCommand: CliCommand = {
  name: 'mcp-serve',
  async run(args, deps) {
    if (args.length !== 0) throw new CliError('invalid_arguments');
    if (isClaudeMcpEntry(deps.env)) {
      const sessionId = deps.env?.[CLAUDE_SESSION_ENV];
      type Hosted = Awaited<ReturnType<NonNullable<CliDependencies['hostedSession']>>>;
      let hosted: Hosted | null = null;
      const open = async () => {
        if (!validIdentifier(sessionId) || !deps.hostedSession) {
          deps.stderr.write('{"component":"hosted_session","stage":"session_identifier","result":"unavailable"}\n');
          return null;
        }
        if (hosted === null) {
          try { hosted = await deps.hostedSession({ harness: 'claude', sessionId }); }
          catch (error) {
            deps.stderr.write('{"component":"hosted_session","stage":"open","result":"unavailable"}\n');
            throw error;
          }
        }
        return hosted;
      };
      const channelsClient: AgentClientPort = {
        ...deps.client,
        async listChannels(input, signal) {
          const opened = await open();
          return opened ? opened.client.listChannels(input, signal) : { kind: 'unavailable' };
        },
        async requestChannelAccess(input, signal) {
          const opened = await open();
          return opened?.client.requestChannelAccess?.(input, signal) ?? { kind: 'unavailable' };
        },
        async channelAccessStatus(input, signal) {
          const opened = await open();
          return opened?.client.channelAccessStatus?.(input, signal) ?? { kind: 'unavailable' };
        },
        async requestChannelCreate(input, signal) {
          if (!input.target) return { kind: 'refused', code: 'invalid_request' };
          const opened = await open();
          return opened?.client.requestChannelCreate?.(input, signal) ?? { kind: 'unavailable' };
        },
        async channelCreateStatus(input, signal) {
          const opened = await open();
          return opened?.client.channelCreateStatus?.(input, signal) ?? { kind: 'unavailable' };
        },
      };
      let retainedToken: string | undefined;
      let sessionBinding: SessionBinding | null = null;
      let localAccessRequested = false;
      const heldDiagnostic = (stage: 'connector_unready' | 'binding_absent' | 'harness_mismatch'
        | 'session_mismatch' | 'binding_changed', errorCode?: string | null) => {
        const code = errorCode && (AGENT_READINESS_ERRORS as readonly string[]).includes(errorCode)
          ? errorCode : undefined;
        deps.stderr.write(JSON.stringify({ component: 'hosted_session', stage, result: 'unavailable',
          ...(code ? { errorCode: code } : {}) }) + '\n');
      };
      const held = async () => {
        const opened = await open();
        if (!opened || !validIdentifier(sessionId)) return null;
        const status = publicStatus(await opened.client.status(deps.signal));
        const binding = status.binding;
        const storedSession = opened.client.storedSessionId?.('claude', sessionId) ?? sessionId;
        if (!status.connected) { heldDiagnostic('connector_unready', status.readiness?.errorCode); return null; }
        if (binding === null) { heldDiagnostic('binding_absent'); return null; }
        if (!['claude', 'proof-key'].includes(binding.harness)) { heldDiagnostic('harness_mismatch'); return null; }
        if (binding.sessionId !== storedSession) { heldDiagnostic('session_mismatch'); return null; }
        if (sessionBinding !== null && !sameHeldBinding(sessionBinding, binding)) {
          heldDiagnostic('binding_changed'); return null;
        }
        sessionBinding = binding;
        return { opened, binding };
      };
      const current = async (binding: SessionBinding) => {
        const selected = await held();
        return selected !== null && sameHeldBinding(binding, selected.binding);
      };
      const hostedTools = {
        selectAccessRoute(internal: boolean) { localAccessRequested = internal; },
        async active() {
          if (!validIdentifier(sessionId)) return false;
          if (!deps.hostedBindingPresent) return true;
          try {
            if (await deps.hostedBindingPresent({ harness: 'claude', sessionId })) return true;
            if (localAccessRequested) return false;
            // No hosted binding is normal before the owner's approval. An exact
            // internal session may still be bound; only that session keeps the
            // internal tools. An unbound session needs hosted access to join.
            return (await deps.claude?.status(sessionId, deps.signal))?.kind !== 'status';
          } catch { return true; } // Uncertain state must not grant internal authority.
        },
        async status() {
          const selected = await held();
          return selected === null ? { kind: 'refused', code: 'not_connected' }
            : { kind: 'status', connected: true };
        },
        async send(message: string) {
          const selected = await held();
          if (selected === null) return { kind: 'refused', code: 'not_connected' };
          const result = await new SendService(selected.opened.client).send(message, selected.binding.bindingId, undefined, deps.signal);
          // A changed binding after the call cannot prove whether the send committed.
          return await current(selected.binding) ? result : { kind: 'outcome_unknown' };
        },
        async read() {
          const selected = await held();
          if (selected === null) return { kind: 'refused', code: 'not_connected' };
          const inbox = await selected.opened.inbox(selected.binding.bindingId, selected.binding.generation);
          const consumer = callScopedConsumer(inbox, { signal: deps.signal, explicitRead: true });
          const read = new ReadOperation({ heldBinding: selected.binding, consumer,
            currentBinding: async () => (await held())?.binding ?? null });
          let result: Awaited<ReturnType<typeof read.read>>;
          try {
            result = await read.read({ bindingId: selected.binding.bindingId, maxBytes: 65_536,
              ...(retainedToken === undefined ? {} : { acknowledgeToken: retainedToken }) });
          } catch (error) {
            if (error instanceof CliError && error.code === 'binding_not_held') {
              return { kind: 'refused', code: 'binding_not_held' };
            }
            throw error;
          }
          if (result.kind === 'empty') return { kind: 'empty' };
          const text = renderInboxBatchWithoutToken(result.batch);
          if (!await current(selected.binding)) return { kind: 'refused', code: 'binding_not_held' };
          retainedToken = result.batch.token;
          return { kind: 'batch', text };
        },
        async roster() {
          const selected = await held();
          if (selected === null) return { kind: 'refused', code: 'session_not_bound' };
          const roster = await selected.opened.client.listAgents({ bindingId: selected.binding.bindingId }, deps.signal);
          return roster.kind === 'listed' ? { kind: 'roster', roster: roster.roster }
            : { kind: 'refused', code: 'unavailable' };
        },
      };
      try {
        await runClaudeMcpServer({ claude: deps.claude,
          channels: composeChannelTools(channelsClient, id => sessionOperationId(sessionId ?? null, id)),
          hosted: deps.hostedSession ? hostedTools : undefined,
          env: deps.env ?? {}, input: deps.stdin, output: deps.stdout, signal: deps.signal });
      } finally { await (hosted as Hosted | null)?.close(); }
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

const PREJOIN_TOOLS = new Set([
  PAIR_TOOL_NAME, CONNECT_TOOL_NAME,
  'khala_list_channels', 'khala_request_channel_access', 'khala_channel_access_status',
  'khala_create_channel', 'khala_channel_create_status',
]);

/**
 * The installed entry routes by the caller-supplied `_meta` local label. That
 * label never authenticates a hosted request: prejoin actions require the
 * connector's signed key and the owner's separate approval. Read/send still
 * require a current binding. Each client and delivery stops with the server.
 */
async function runSessionMcpServer(deps: CliDependencies, grants: SessionGrants): Promise<void> {
  if (!deps.internalClient || !deps.internalDelivery) throw new CliError('internal_unavailable');
  const { internalClient, internalDelivery } = deps;
  type Routed = { client: AgentClientPort; delivering: DeliveringInbox; wake: (() => Promise<void>) | null;
    bound: { binding: SessionBinding; collaborators: McpCallCollaborators } | null };
  const sessions = new Map<string, Routed>();
  type Hosted = Awaited<ReturnType<NonNullable<CliDependencies['hostedSession']>>>;
  const hosted = new Map<string, { opened: Hosted; bound: { binding: SessionBinding; collaborators: McpCallCollaborators } | null;
    startupDeadline: number | null }>();
  try {
    await runMcpServer({
      input: deps.stdin,
      output: deps.stdout,
      signal: deps.signal,
      async route(meta, toolName, args) {
        const session = harnessSessionFromMeta(meta);
        if (session === null) return null;
        const hostedCreate = toolName === 'khala_create_channel' && typeof args.target === 'string';
        const grantPath = grants(session);
        let routed = sessions.get(grantPath);
        if (routed === undefined) {
          const client = await internalClient(grantPath);
          const delivering = deliveringInbox(deps.inbox,
            await internalDelivery(grantPath, async () => { await routed?.wake?.(); }),
            deps.signal ? { signal: deps.signal } : {});
          routed = { client, delivering, wake: null, bound: null };
          sessions.set(grantPath, routed);
        }
        const current = publicStatus(await routed.client.status(deps.signal));
        if (!hostedCreate && current.connected && current.binding !== null) {
          if (routed.bound === null || !sameHeldBinding(routed.bound.binding, current.binding)) {
            try {
              routed.wake = session.harness === 'codex' && deps.codexIdleWake
                ? await deps.codexIdleWake(session.sessionId, current.binding) : null;
            } catch {
              // Optional notification never prevents an explicit Khala tool call.
              routed.wake = null;
            }
            routed.bound = {
              binding: current.binding,
              collaborators: await boundCollaborators(deps, routed.client, routed.delivering.inbox, current.binding),
            };
          }
          return routed.bound.collaborators;
        }
        if (deps.hostedSession === undefined) return null;
        let entry = hosted.get(session.sessionId);
        if (entry === undefined) {
          if (!PREJOIN_TOOLS.has(toolName)
            && deps.hostedBindingPresent && !await deps.hostedBindingPresent(session)) return null;
          entry = { opened: await deps.hostedSession(session), bound: null, startupDeadline: null };
          hosted.set(session.sessionId, entry);
        }
        let hostedStatus = publicStatus(await entry.opened.client.status(deps.signal));
        if (!PREJOIN_TOOLS.has(toolName) && hostedStatus.readiness?.errorCode === 'subscription_starting'
          && !hostedStatus.connected && deps.hostedBindingPresent && await deps.hostedBindingPresent(session)) {
          // The saved binding can precede the new process's intake subscription.
          // Bound the wait across calls to this MCP process, even on repeated retries.
          const deadline = entry.startupDeadline ??= Date.now() + 8_000;
          while (!hostedStatus.connected && hostedStatus.readiness?.errorCode === 'subscription_starting'
            && Date.now() < deadline) {
            await delay(Math.min(500, deadline - Date.now()), undefined, { signal: deps.signal });
            hostedStatus = publicStatus(await entry.opened.client.status(deps.signal));
          }
          if (!hostedStatus.connected && hostedStatus.readiness?.errorCode === 'subscription_starting') {
            // A removed approval must never be presented as an ordinary startup retry.
            if (!await deps.hostedBindingPresent(session)) return null;
            throw new CliError('connector_starting');
          }
        }
        if (!hostedStatus.connected || hostedStatus.binding === null) {
          return PREJOIN_TOOLS.has(toolName)
            ? pairingCollaborators(entry.opened.client) : null;
        }
        const storedSessionId = entry.opened.client.storedSessionId?.(session.harness, session.sessionId) ?? session.sessionId;
        if (!([session.harness, 'proof-key'].includes(hostedStatus.binding.harness))
          || hostedStatus.binding.sessionId !== storedSessionId) return null;
        if (entry.bound !== null && !sameHeldBinding(entry.bound.binding, hostedStatus.binding)) return null;
        if (entry.bound === null || !sameHeldBinding(entry.bound.binding, hostedStatus.binding)) {
          entry.bound = {
            binding: hostedStatus.binding,
            collaborators: await boundCollaborators(deps, entry.opened.client, entry.opened.inbox, hostedStatus.binding),
          };
        }
        return entry.bound.collaborators;
      },
    });
  } finally {
    await Promise.all([
      ...[...sessions.values()].map(routed => routed.delivering.stop()),
      ...[...hosted.values()].map(entry => entry.opened.close()),
    ]);
  }
}

/** Pairing has no release or read authority until admission returns a held binding. */
function pairingCollaborators(client: AgentClientPort): McpCallCollaborators {
  return {
    send: new SendService(client),
    read: { async read() { throw new CliError('not_connected'); } },
    listeningMode: new ListeningModeOperation({ application: null }),
    channels: composeChannelTools(client),
    pair: new PairingService(client),
    connect: new ConnectService(client),
    postprocessResult: async input => input.primaryResult,
    postprocessReadResult: async input => ({ kind: 'composed', result: input.primaryResult }),
  };
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
    send: new SendService(client, heldBinding.bindingId),
    read: new ReadOperation({ heldBinding, consumer, currentBinding }),
    // A routed session's mode control is its own descriptor's binding, as under `--internal-descriptor`.
    listeningMode: new ListeningModeOperation({ application: client.listeningModeControl ?? deps.listeningMode ?? null }),
    channels: composeChannelTools(client),
    pair: new PairingService(client),
    connect: new ConnectService(client),
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
