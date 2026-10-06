import path from 'node:path';
import { createCopilotCodec } from '../src/harness/codecs/copilot';
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
  const antigravityEvent = argv.length === 4 && argv[0] === '--harness' && argv[1] === 'antigravity'
    && argv[2] === '--event' && ['PreInvocation', 'Stop'].includes(argv[3]!) ? argv[3] : undefined;
  let adapter = (argv.length === 2 || museRoots || antigravityEvent || (argv.length === 4 && argv[1] === 'copilot' && argv[2] === '--event'))
    && argv[0] === '--harness' ? adapterFor(argv[1]!) : undefined;
  if (antigravityEvent) {
    try { stdin = JSON.stringify({ ...JSON.parse(stdin), khalaHookEvent: antigravityEvent }); }
    catch { stdin = '{}'; }
  }
  if (adapter?.id === 'copilot' && argv.length === 4) adapter = { ...adapter, codec: createCopilotCodec(argv[3]) };
  if (!adapter?.codec) {
    diagnostic(io, 'invalid_harness');
    return 0;
  }
  return deliverCore(stdin, adapter, { ...io, env });
}

export async function deliverCursor(stdin: string, io: HookIO): Promise<number> {
  return deliverCore(stdin, adapterFor('cursor')!, io);
}
