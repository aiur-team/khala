import type { BindingId } from '@khala/contracts/delivery/index';
import { validBindingArgument } from '../../cli/validation.js';
import { READ_TOOL_NAME, executeReadTool, readToolDefinition, readToolFailure } from '../read-tool.js';
import { extractSharedToolArguments, failure, hasOnly, success, type McpTool } from '../tool.js';

export const readTool: McpTool = {
  name: READ_TOOL_NAME,
  definition: readToolDefinition,
  async call(argumentsValue, { id, notification, read, postprocessReadResult }) {
    // Notifications are intentionally ineligible for read and acknowledgement;
    // there is no response channel on which a selected batch could be delivered.
    if (notification) return success(id, {});

    const shared = extractSharedToolArguments(argumentsValue);
    if (shared === null || !hasOnly(shared.arguments, ['bindingId'])) {
      return failure(id, -32602, 'Invalid params');
    }
    let bindingId: BindingId | null = null;
    if (Object.hasOwn(shared.arguments, 'bindingId')) {
      if (!validBindingArgument(shared.arguments.bindingId)) return failure(id, -32602, 'Invalid params');
      bindingId = shared.arguments.bindingId;
    }

    const execution = await executeReadTool({
      responseId: id,
      arguments: { bindingId },
      read,
      ...(shared.acknowledgeToken === undefined ? {} : { acknowledgeToken: shared.acknowledgeToken }),
    });
    if (execution.kind === 'error' || postprocessReadResult === undefined) {
      return success(id, execution.primaryResult);
    }
    try {
      const outcome = await postprocessReadResult({
        responseId: id,
        primaryResult: execution.primaryResult,
        preselectedBatch: execution.preselectedBatch,
      });
      return success(id, outcome.kind === 'composed'
        ? outcome.result
        : readToolFailure(outcome.code).primaryResult);
    } catch {
      return success(id, readToolFailure('internal_error').primaryResult);
    }
  },
};
