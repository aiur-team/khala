#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './app.js';
import { openInbox } from './inbox.js';
import { bundledInternalRuntime } from './internal.js';
import { MAX_SEND_BYTES } from './send.js';
import { createUnavailableClient } from '../composition/unavailable.js';
import { createDiscoveryOnlyAdapter, createNodeSetupProbe } from '../setup/detect.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { createSetupService, type SetupExecute } from '../setup/plan.js';
import { executeSetupPlan } from '../setup/transaction.js';
import { HARNESS_IDS, type SetupEnvironment } from '../setup/types.js';

/** Builds the setup environment from explicit HOME/XDG/PATH values only; nothing else is inherited. */
export function setupEnvironment(env: NodeJS.ProcessEnv): SetupEnvironment {
  const paths = resolveSetupPaths(env);
  const probeEnvironment = {
    HOME: paths.home, XDG_CONFIG_HOME: paths.configHome, XDG_DATA_HOME: paths.dataHome,
    XDG_STATE_HOME: paths.stateHome, PATH: paths.pathEntries.join(path.delimiter),
  };
  return {
    home: paths.home, xdgConfigHome: paths.configHome, xdgDataHome: paths.dataHome, xdgStateHome: paths.stateHome,
    probe: createNodeSetupProbe({ pathEntries: paths.pathEntries, environment: probeEnvironment }),
  };
}

/** Applies a confirmed plan through the transactional executor, rooted at the same HOME/XDG/PATH. */
export function setupExecute(env: NodeJS.ProcessEnv): SetupExecute {
  return request => {
    const paths = resolveSetupPaths(env);
    return executeSetupPlan({
      roots: { home: paths.home, xdgConfigHome: paths.configHome, xdgDataHome: paths.dataHome, xdgStateHome: paths.stateHome },
      searchPath: paths.pathEntries.join(path.delimiter),
      confirmedDigest: request.confirmedDigest,
      // The executor passes its committed manifest; adapters observe the same state themselves.
      replan: () => request.replan(),
    });
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const stateDirectory = path.resolve(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'khala');
  const abort = new AbortController();
  const stop = () => abort.abort();
  // Kept installed until the command returns, so a repeated Ctrl+C cannot cut a shutdown short.
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    return await runCli(argv, {
      client: createUnavailableClient(),
      // No trusted connector composition is installed yet, so mode calls refuse as unavailable.
      listeningMode: null,
      inbox: (bindingId, generation) => openInbox({
        stateDirectory, bindingId, generation, maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
      }),
      setup: createSetupService({
        environment: () => setupEnvironment(process.env),
        // Real harness adapters replace these one by one; until then a detected harness is unsupported.
        adapters: HARNESS_IDS.map(createDiscoveryOnlyAdapter),
        execute: setupExecute(process.env),
      }),
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: abort.signal,
      internal: bundledInternalRuntime(import.meta.url), env: process.env, cwd: process.cwd(),
      internalClient: async descriptorPath =>
        (await import('../composition/internal.js')).createInternalClient({ descriptorPath }),
      internalDelivery: async descriptorPath =>
        (await import('../composition/internal-delivery.js')).createInternalDelivery({ descriptorPath, stateDirectory }),
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
