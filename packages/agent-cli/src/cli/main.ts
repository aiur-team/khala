#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './app.js';
import { openInbox } from './inbox.js';
import { MAX_SEND_BYTES } from './send.js';
import { createUnavailableClient } from '../composition/unavailable.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const stateDirectory = path.resolve(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'khala');
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await runCli(argv, {
      client: createUnavailableClient(),
      // No trusted connector composition is installed yet, so mode calls refuse as unavailable.
      listeningMode: null,
      inbox: (bindingId, generation) => openInbox({
        stateDirectory, bindingId, generation, maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
      }),
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: abort.signal,
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
