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
  let adapter = (argv.length === 2 || (argv.length === 4 && argv[1] === 'copilot' && argv[2] === '--event'))
    && argv[0] === '--harness' ? adapterFor(argv[1]!) : undefined;
  if (adapter?.id === 'copilot' && argv.length === 4) adapter = { ...adapter, codec: createCopilotCodec(argv[3]) };
  if (!adapter?.codec) {
    diagnostic(io, 'invalid_harness');
    return 0;
  }
  return deliverCore(stdin, adapter, io);
}

export async function deliverCursor(stdin: string, io: HookIO): Promise<number> {
  return deliverCore(stdin, adapterFor('cursor')!, io);
}
