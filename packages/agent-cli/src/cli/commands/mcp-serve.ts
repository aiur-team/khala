import { ListeningModeOperation } from '../../composition/listening-mode.js';
import { ReadOperation, sameHeldBinding } from '../../composition/read.js';
import {
  postprocessMcpResult, postprocessPreselectedMcpResult, type McpPostprocessSuppression,
} from '../../mcp/result-postprocessor.js';
import { runMcpServer } from '../../mcp/server.js';
import { ChannelListingService } from '../channels/service.js';
import { CliError } from '../errors.js';
import { publicStatus } from '../runtime.js';
import { SendService } from '../send.js';
import type { CliCommand } from '../types.js';

export const mcpServeCommand: CliCommand = {
  name: 'mcp-serve',
  async run(args, deps) {
    if (args.length !== 0) throw new CliError('invalid_arguments');
    const current = publicStatus(await deps.client.status(deps.signal));
    if (!current.connected || current.binding === null) throw new CliError('not_connected');
    const heldBinding = current.binding;
    const inbox = await deps.inbox(heldBinding.bindingId, heldBinding.generation);
    const consumer = await inbox.acquireListener();
    try {
      const currentBinding = async () => {
        const latest = publicStatus(await deps.client.status(deps.signal));
        return latest.connected ? latest.binding : null;
      };
      // Suppressed batches fail open to the plain tool result; report the
      // content-free stage and code so the operator can see why nothing arrived.
      const onSuppressed = (suppression: McpPostprocessSuppression) => {
        deps.stderr.write(JSON.stringify({ ok: false, warning: 'batch_suppressed', ...suppression }) + '\n');
      };
      await runMcpServer({
        input: deps.stdin,
        output: deps.stdout,
        send: new SendService(deps.client),
        read: new ReadOperation({ heldBinding, consumer, currentBinding }),
        listeningMode: new ListeningModeOperation({ application: deps.listeningMode ?? null }),
        channels: new ChannelListingService(deps.client),
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
        signal: deps.signal,
      });
    } finally {
      await consumer.release();
    }
    return 0;
  },
};
