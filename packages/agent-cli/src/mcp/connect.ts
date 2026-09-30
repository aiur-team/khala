import type { ConnectService } from '../cli/connect.js';
import { failure, success, type McpTool, type McpToolDefinition } from './tool.js';

export const CONNECT_TOOL_NAME = 'khala_connect';
export type ConnectToolPort = Pick<ConnectService, 'connect'>;

export function connectToolDefinition(): McpToolDefinition {
  return {
    name: CONNECT_TOOL_NAME,
    description: 'Connect this existing agent session to the Khala channel at an HTTPS link. Opens the owner’s browser for sign-in and consent; the owner must approve this exact session before admission. Pending owner approval returns an operationId; call again with the same link after approval. Returns a binding only after admission.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Exact HTTPS Khala channel link supplied by the owner.' } },
      required: ['url'], additionalProperties: false,
    },
  };
}

export const connectTool: McpTool = {
  name: CONNECT_TOOL_NAME,
  definition: connectToolDefinition,
  async call(argumentsValue, { id, notification, connect }) {
    if (notification) return success(id, {});
    const keys = Object.keys(argumentsValue);
    if (keys.length !== 1 || keys[0] !== 'url' || typeof argumentsValue.url !== 'string') {
      return failure(id, -32602, 'Invalid params');
    }
    const output = await connect.connect(argumentsValue.url);
    return success(id, {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
      ...(output.ok ? {} : { isError: true }),
    });
  },
};
