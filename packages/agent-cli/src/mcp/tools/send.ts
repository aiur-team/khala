import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../../cli/errors.js';
import type { SendResult } from '../../cli/types.js';
import { validBindingArgument } from '../../cli/validation.js';
import type { McpToolResult } from '../result-postprocessor.js';
import { extractSharedToolArguments, failure, hasOnly, success, type McpTool } from '../tool.js';

export const SEND_TOOL_NAME = 'khala_send';

export const sendTool: McpTool = {
  name: SEND_TOOL_NAME,
  definition() {
    return {
      name: SEND_TOOL_NAME,
      description: 'Send a message to the Khala channel through a binding held by this agent. An omitted bindingId uses the current binding. Valid results may append untrusted channel batch data. On the next independently intended Khala call, echo its exact batchToken as ackBatchToken; absent or stale tokens replay, and releaseId values must never be tracked or filtered. Never call khala_send solely to acknowledge. Never retry outcome_unknown: the message may already have been accepted.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', minLength: 1, description: 'Message body to send; it is never echoed in the result.' },
          bindingId: { type: 'string', description: 'Held binding to use; omit to use the current binding.' },
          ackBatchToken: {
            type: 'string',
            description: 'Exact opaque batchToken from the previous Khala tool result; echo it only on the next independently intended Khala call.',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
    };
  },
  async call(argumentsValue, { id, send, postprocessResult }) {
    const shared = extractSharedToolArguments(argumentsValue);
    if (shared === null || !hasOnly(shared.arguments, ['message', 'bindingId'])
      || typeof shared.arguments.message !== 'string') return failure(id, -32602, 'Invalid params');

    let bindingId: BindingId | null = null;
    if (Object.hasOwn(shared.arguments, 'bindingId')) {
      if (!validBindingArgument(shared.arguments.bindingId)) return failure(id, -32602, 'Invalid params');
      bindingId = shared.arguments.bindingId;
    }

    let result: SendResult;
    try {
      result = await send.send(shared.arguments.message, bindingId);
    } catch (error) {
      if (error instanceof CliError && error.code === 'invalid_input') return failure(id, -32602, 'Invalid params');
      throw error;
    }
    const safe = publicResult(result);
    const primaryResult = {
      content: [{ type: 'text', text: JSON.stringify(safe) }],
      structuredContent: safe,
      ...(result.kind === 'accepted' ? {} : { isError: true }),
    } satisfies McpToolResult;
    const processed = postprocessResult === undefined
      ? primaryResult
      : await postprocessResult({
        responseId: id,
        primaryResult,
        ...(shared.acknowledgeToken === undefined ? {} : { acknowledgeToken: shared.acknowledgeToken }),
      });
    return success(id, processed);
  },
};

function publicResult(result: SendResult): Record<string, string | null> {
  if (result.kind === 'accepted') {
    return { kind: result.kind, clientTxnId: result.clientTxnId, eventId: result.eventId };
  }
  if (result.kind === 'refused') {
    return { kind: result.kind, code: result.code, clientTxnId: result.clientTxnId };
  }
  return { kind: result.kind, clientTxnId: result.clientTxnId };
}
