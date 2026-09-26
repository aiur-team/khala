import { MAX_SEND_BYTES, SendService } from '../send.js';
import { optionalBinding, publicSendOutput, readStdin, write } from '../runtime.js';
import type { CliCommand } from '../types.js';

export const sendCommand: CliCommand = {
  name: 'send',
  async run(args, deps) {
    const bindingId = optionalBinding(args);
    const body = await readStdin(deps.stdin, MAX_SEND_BYTES);
    const result = await new SendService(deps.client).send(body, bindingId, undefined, deps.signal);
    await write(deps.stdout, JSON.stringify(publicSendOutput(result)) + '\n');
    return result.kind === 'accepted' ? 0 : result.kind === 'refused' ? 3 : 4;
  },
};
