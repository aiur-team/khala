import type { PairOutput, PairingService } from '../cli/pair.js';
import type { McpToolResult } from './result-postprocessor.js';
import { failure, success, type McpTool, type McpToolDefinition } from './tool.js';

export const PAIR_TOOL_NAME = 'khala_pair';

export type PairToolPort = Pick<PairingService, 'pair'>;

export function pairToolDefinition(): McpToolDefinition {
  return {
    name: PAIR_TOOL_NAME,
    description: 'Connect this running agent session to a Khala channel with the pairing code the human read from that channel. The owner must approve this exact session before anything is connected; the call waits up to five minutes. Returns the binding on success, or a finite error such as pairing_refused, pairing_denied, pairing_expired, or approval_pending. Call it again with the same code to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The ten-character pairing code, for example 7K3QX-9MZ2P. Case and spacing are ignored.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  };
}

/**
 * `khala_pair` shares `PairingService` with `khala pair`, so both return the same
 * object. It is not an inbox surface: it takes no batch token and its result
 * never carries released messages.
 */
export const pairTool: McpTool = {
  name: PAIR_TOOL_NAME,
  definition: pairToolDefinition,
  async call(argumentsValue, { id, notification, pair }) {
    // A notification has no response channel, so it must not start a claim the owner then sees.
    if (notification) return success(id, {});
    const keys = Object.keys(argumentsValue);
    if (keys.length !== 1 || keys[0] !== 'code' || typeof argumentsValue.code !== 'string') return failure(id, -32602, 'Invalid params');
    return success(id, toolResult(await pair.pair(argumentsValue.code)));
  },
};

function toolResult(output: PairOutput): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
    ...(output.ok ? {} : { isError: true }),
  };
}
