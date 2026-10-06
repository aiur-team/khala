import path from 'node:path';
import { adapterFor } from '../src/harness';
import { deliverCore, diagnostic, type HookIO } from '../src/harness/deliver-core';

export { renderLine, renderFrame, selectFrames } from '../src/harness/deliver-core';

export default async function run(stdin: string, argv: readonly string[]): Promise<number> {
  return deliver(stdin, argv);
}
export async function deliver(stdin: string, argv: readonly string[], io: HookIO = {
  stdout: process.stdout, stderr: process.stderr, env: process.env, now: () => new Date(),
}): Promise<number> {
  let env = io.env;
  const museRoots = argv.length === 6 && argv[0] === '--harness' && argv[1] === 'muse'
    && argv[2] === '--state-home' && argv[4] === '--data-home'
    && path.isAbsolute(argv[3]!) && path.isAbsolute(argv[5]!);
  if (museRoots) env = { ...env, XDG_STATE_HOME: argv[3], XDG_DATA_HOME: argv[5] };
  const adapter = (argv.length === 2 || museRoots) && argv[0] === '--harness' ? adapterFor(argv[1]!) : undefined;
  if (!adapter?.codec) {
    diagnostic(io, 'invalid_harness');
    return 0;
  }
  return deliverCore(stdin, adapter, { ...io, env });
}

export async function deliverCursor(stdin: string, io: HookIO): Promise<number> {
  return deliverCore(stdin, adapterFor('cursor')!, io);
}
