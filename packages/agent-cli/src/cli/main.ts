#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_ACTIVE_DESCRIPTOR_FILE } from '@khala/contracts/internal/descriptor';
import { hasProductionBinding, openProductionConnector } from '@khala/connector-app/composition/production';
import { runCli } from './app.js';
import { openInbox } from './inbox.js';
import { bundledInternalRuntime } from './internal.js';
import { MAX_SEND_BYTES } from './send.js';
import { isClaudeMcpEntry } from '../composition/claude-mcp.js';
import { createClaudeSessionClient } from '../composition/claude-session-http.js';
import type { OpenGenerationInbox } from '../composition/delivering-inbox.js';
import { installedHostedSession } from '../composition/hosted-main.js';
import { hostedAppOrigin } from '../composition/hosted-production.js';
import { sessionGrants } from '../composition/session-grant.js';
import { packagedSetupService } from '../composition/setup.js';
import { createUnavailableClient } from '../composition/unavailable.js';
import type { AgentClientPort, CliDependencies } from './types.js';
import { validIdentifier } from './validation.js';
import { setupEnvironment } from '../setup/environment.js';
import { resolveSetupPaths } from '../setup/paths.js';
import type { SetupExecute } from '../setup/plan.js';
import { PAYLOAD_DIRECTORY } from '../setup/payload.js';
import { executeSetupPlan } from '../setup/transaction.js';

export { setupEnvironment };

/** Shell commands use the native Codex label only as a selector; the connector owns authority. */
export function nativeShellCreateClient(sessionId: string | undefined,
  hostedSession: NonNullable<CliDependencies['hostedSession']>): Readonly<{
  client: AgentClientPort; close(): Promise<void>;
}> {
  const opened: { current: Awaited<ReturnType<typeof hostedSession>> | null } = { current: null };
  const select = async () => {
    if (!validIdentifier(sessionId)) return null;
    opened.current ??= await hostedSession({ harness: 'codex', sessionId });
    return opened.current.client;
  };
  return {
    client: { ...createUnavailableClient(),
      async requestChannelCreate(input, signal) {
        if (!input.target) return { kind: 'refused', code: 'invalid_request' };
        const selected = await select();
        return selected?.requestChannelCreate?.(input, signal) ?? { kind: 'refused', code: 'discovery_required' };
      },
      async channelCreateStatus(input, signal) {
        const selected = await select();
        return selected?.channelCreateStatus?.(input, signal) ?? { kind: 'refused', code: 'discovery_required' };
      },
    },
    async close() { await opened.current?.close(); },
  };
}

/** Applies a confirmed plan through the transactional executor, rooted at the same HOME/XDG/CODEX_HOME/PATH. */
export function setupExecute(env: NodeJS.ProcessEnv): SetupExecute {
  return request => {
    const paths = resolveSetupPaths(env);
    return executeSetupPlan({
      roots: {
        home: paths.home, xdgConfigHome: paths.configHome, xdgDataHome: paths.dataHome, xdgStateHome: paths.stateHome,
        codexHome: paths.codexHome,
      },
      searchPath: paths.pathEntries.join(path.delimiter),
      confirmedDigest: request.confirmedDigest,
      // The executor passes its committed manifest; adapters observe the same state themselves.
      replan: () => request.replan(),
    });
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const stateDirectory = path.resolve(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'khala');
  const internalRoot = path.join(stateDirectory, 'internal');
  // The internal server's owner-only runtime descriptor; the Claude entry re-reads it on every call.
  const activeDescriptor = path.join(internalRoot, INTERNAL_ACTIVE_DESCRIPTOR_FILE);
  const abort = new AbortController();
  const stop = () => abort.abort();
  // Kept installed until the command returns, so a repeated Ctrl+C cannot cut a shutdown short.
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  // The staged runtime behind the `khala` launcher carries no payload, so it composes no setup:
  // its `status` reports the connection only, and setup runs from the published package.
  const setup = existsSync(path.join(distDirectory, PAYLOAD_DIRECTORY)) ? packagedSetupService({
    distDirectory,
    nodePath: process.execPath,
    environment: () => setupEnvironment(process.env),
    execute: setupExecute(process.env),
    cwd: process.cwd(),
  }) : undefined;
  const openGenerationInbox: OpenGenerationInbox = (bindingId, generation, inboxOptions) => openInbox({
    stateDirectory, bindingId, generation, maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
    ...(inboxOptions?.recordAcknowledgement === undefined ? {} : { recordAcknowledgement: inboxOptions.recordAcknowledgement }),
    ...(inboxOptions?.issueBatch === undefined ? {} : { issueBatch: inboxOptions.issueBatch }),
  });
  const hostedSession = installedHostedSession({
    openConnector: openProductionConnector, environment: process.env, stateDirectory,
    distDirectory, workdir: process.cwd(), openInbox: openGenerationInbox,
  });
  const shell = nativeShellCreateClient(process.env.CODEX_THREAD_ID, hostedSession);
  try {
    return await runCli(argv, {
      client: shell.client,
      // Codex exports its thread label to agent commands. The connector still
      // inspects this exact session and requires owner approval of its key.
      // Under `--internal-descriptor` the descriptor client supplies its own binding's mode control.
      listeningMode: null,
      // An internal descriptor's delivering inbox supplies the recorder that writes its receipts.
      inbox: openGenerationInbox,
      hostedSession,
      hostedOrigin: hostedAppOrigin(process.env.KHALA_APP_ORIGIN),
      hostedBindingPresent: session => hasProductionBinding(path.join(stateDirectory, 'hosted'),
        { ...session, workdir: path.resolve(process.cwd()) }),
      ...(setup === undefined ? {} : { setup }),
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: abort.signal,
      internal: bundledInternalRuntime(import.meta.url), env: process.env, cwd: process.cwd(),
      // The Claude plugin's hooks and `mcp-serve` reach the running internal server through it.
      claude: createClaudeSessionClient({ descriptorPath: activeDescriptor }),
      // The Codex and OpenCode `mcp-serve` entries and `khala codex-hook` carry no
      // `--internal-descriptor`: each call acts as its own session's `grant.json`. The Claude
      // entry's `mcp-serve` runs its session server over `claude` instead.
      ...(isClaudeMcpEntry(process.env) ? {} : { sessionGrants: sessionGrants(internalRoot) }),
      // The mode status hooks act on is projected through the harness running here, read as setup reads it.
      internalClient: async descriptorPath => {
        const [{ createInternalClient }, { localHarness }] = await Promise.all([
          import('../composition/internal.js'), import('../composition/local-harness-capabilities.js'),
        ]);
        const harness = localHarness(() => setupEnvironment(process.env));
        return createInternalClient({ descriptorPath, capabilities: harness.capabilities, observation: harness.observation });
      },
      internalDelivery: async (descriptorPath, onWake) =>
        (await import('../composition/internal-delivery.js')).createInternalDelivery({ descriptorPath, stateDirectory,
          ...(onWake ? { onWake } : {}) }),
      codexBoundary: async (binding, idle, sessionId) => {
        const { createCodexIdleActivity } = await import('../composition/codex-idle-activity.js');
        await createCodexIdleActivity(stateDirectory).mark(binding, idle, sessionId);
        if (idle) {
          const { createInstalledCodexTurnEnd } = await import('../composition/codex-installed-wake.js');
          await createInstalledCodexTurnEnd({ sessionId, binding,
            descriptorPath: sessionGrants(internalRoot)({ harness: 'codex', sessionId }) })().catch(() => undefined);
        }
      },
      codexIdleWake: async (sessionId, binding) => {
        const { createInstalledCodexWake } = await import('../composition/codex-installed-wake.js');
        return createInstalledCodexWake({ sessionId, binding,
          descriptorPath: sessionGrants(internalRoot)({ harness: 'codex', sessionId }) });
      },
    });
  } finally {
    await shell.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
