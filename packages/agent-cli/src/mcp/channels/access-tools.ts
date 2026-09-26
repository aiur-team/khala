import { defaultOperationId, parseAccessTarget, validOperationArgument } from '../../cli/channels/access.js';
import { validOriginArgument } from '../../cli/channels/service.js';
import type { McpTool } from '../tool.js';
import { callListingTool } from './tools.js';

export const REQUEST_CHANNEL_ACCESS_TOOL_NAME = 'khala_request_channel_access';
export const CHANNEL_ACCESS_STATUS_TOOL_NAME = 'khala_channel_access_status';

const ACK_BATCH_TOKEN_SCHEMA = {
  type: 'string',
  description: 'Exact opaque batchToken from the previous Khala tool result; echo it only on the next independently intended Khala call.',
} as const;
const OPERATION_SCHEMA = {
  type: 'string',
  description: 'Idempotent operation ID. Reuse the one returned by an earlier call to retry or read status; never invent a new one to retry.',
} as const;
const ORIGIN_SCHEMA = {
  type: 'string',
  description: 'Exact configured Khala service origin; omit to use the channel URL origin or the default.',
} as const;

export const requestChannelAccessTool: McpTool = {
  name: REQUEST_CHANNEL_ACCESS_TOOL_NAME,
  definition: () => ({
    name: REQUEST_CHANNEL_ACCESS_TOOL_NAME,
    description: 'Ask the channel owner for access to a Khala channel, named by a listingRef from khala_list_channels or a channel URL. Returns promptly, usually pending_owner: the owner decides in their own UI and nothing here grants access. Retries reuse the operationId; if next is reuse_operation_id or repair_connector, follow it instead of requesting again.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A listingRef or a channel URL.' },
        operationId: OPERATION_SCHEMA,
        origin: ORIGIN_SCHEMA,
        ackBatchToken: ACK_BATCH_TOKEN_SCHEMA,
      },
      required: ['target'],
      additionalProperties: false,
    },
  }),
  call: (argumentsValue, context) => callListingTool(argumentsValue, context, async (args, channels) => {
    if (!Object.keys(args).every(key => key === 'target' || key === 'operationId' || key === 'origin')) return null;
    const target = parseAccessTarget(args.target);
    const operationId = Object.hasOwn(args, 'operationId')
      ? args.operationId : target === null ? null : defaultOperationId(target);
    const origin = Object.hasOwn(args, 'origin') ? args.origin : null;
    if (target === null || !validOperationArgument(operationId) || (origin !== null && !validOriginArgument(origin))) return null;
    return channels.request({ target, operationId, origin });
  }),
};

export const channelAccessStatusTool: McpTool = {
  name: CHANNEL_ACCESS_STATUS_TOOL_NAME,
  definition: () => ({
    name: CHANNEL_ACCESS_STATUS_TOOL_NAME,
    description: 'Read the current state of one channel-access request by operationId. Owner-decision states (pending_owner, denied, expired, revoked) stay separate from connector-readiness states (approved, connecting, connected, repair_required). Does not poll; call again only when the result may have changed.',
    inputSchema: {
      type: 'object',
      properties: { operationId: OPERATION_SCHEMA, origin: ORIGIN_SCHEMA, ackBatchToken: ACK_BATCH_TOKEN_SCHEMA },
      required: ['operationId'],
      additionalProperties: false,
    },
  }),
  call: (argumentsValue, context) => callListingTool(argumentsValue, context, async (args, channels) => {
    if (!Object.keys(args).every(key => key === 'operationId' || key === 'origin')) return null;
    const origin = Object.hasOwn(args, 'origin') ? args.origin : null;
    if (!validOperationArgument(args.operationId) || (origin !== null && !validOriginArgument(origin))) return null;
    return channels.status({ operationId: args.operationId, origin });
  }),
};
