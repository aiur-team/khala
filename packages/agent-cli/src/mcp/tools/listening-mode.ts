import {
  LISTENING_MODE_TOOL_NAME, executeListeningModeTool, listeningModeToolDefinition,
} from '../listening-mode-tool.js';
import { extractSharedToolArguments, failure, success, type McpTool } from '../tool.js';

export const listeningModeTool: McpTool = {
  name: LISTENING_MODE_TOOL_NAME,
  definition: listeningModeToolDefinition,
  async call(argumentsValue, { id, notification, listeningMode, postprocessResult }) {
    // A notification has no response channel for the mode result, so it must
    // neither inspect nor mutate mode, nor acknowledge a batch.
    if (notification) return success(id, {});

    const shared = extractSharedToolArguments(argumentsValue);
    if (shared === null) return failure(id, -32602, 'Invalid params');
    const primaryResult = await executeListeningModeTool(shared.arguments, listeningMode);
    if (primaryResult === null) return failure(id, -32602, 'Invalid params');
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
