#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_ACTIVE_DESCRIPTOR_FILE } from '@khala/contracts/internal/descriptor';
import { runCli } from './app.js';
import { openInbox } from './inbox.js';
import { bundledInternalRuntime } from './internal.js';
import { MAX_SEND_BYTES } from './send.js';
import { isClaudeMcpEntry } from '../composition/claude-mcp.js';
import { createClaudeSessionClient } from '../composition/claude-session-http.js';
import { sessionGrants } from '../composition/session-grant.js';
import { packagedSetupService } from '../composition/setup.js';
import { createUnavailableClient } from '../composition/unavailable.js';
import { setupEnvironment } from '../setup/environment.js';
import { resolveSetupPaths } from '../setup/paths.js';
import type { SetupExecute } from '../setup/plan.js';
import { PAYLOAD_DIRECTORY } from '../setup/payload.js';
import { executeSetupPlan } from '../setup/transaction.js';

export { setupEnvironment };

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
  try {
    return await runCli(argv, {
      client: createUnavailableClient(),
      // No trusted connector composition is installed yet, so mode calls refuse as unavailable.
      // Under `--internal-descriptor` the descriptor client supplies its own binding's mode control.
      listeningMode: null,
      // An internal descriptor's delivering inbox supplies the recorder that writes its receipts.
      inbox: (bindingId, generation, inboxOptions) => openInbox({
        stateDirectory, bindingId, generation, maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
        ...(inboxOptions?.recordAcknowledgement === undefined ? {} : { recordAcknowledgement: inboxOptions.recordAcknowledgement }),
      }),
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
      internalDelivery: async descriptorPath =>
        (await import('../composition/internal-delivery.js')).createInternalDelivery({ descriptorPath, stateDirectory }),
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
