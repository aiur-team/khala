#!/usr/bin/env node
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './app.js';
import { openInbox } from './inbox.js';
import { createUnavailableClient } from '../composition/unavailable.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const stateDirectory = path.resolve(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'khala');
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await runCli(argv, {
      client: createUnavailableClient(),
      inbox: (bindingId, generation) => openInbox({ stateDirectory, bindingId, generation, maxPayloadBytes: 65_536 }),
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: abort.signal,
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
