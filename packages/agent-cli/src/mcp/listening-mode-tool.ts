import {
  LISTENING_MODES, parseSetRequest, type ListeningModeOperation, type ListeningModeOutcome,
} from '../composition/listening-mode.js';
import { CliError } from '../cli/errors.js';
import { plainObject } from '../cli/validation.js';
import type { McpToolResult } from './result-postprocessor.js';

export const LISTENING_MODE_TOOL_NAME = 'khala_listening_mode';

export type ListeningModeOperationPort = Pick<ListeningModeOperation, 'get' | 'set'>;

/**
 * Runs one validated get/set call. Returns null for malformed arguments so the
 * server can answer -32602 before any inspection, mutation, or acknowledgement.
 * The caller has already removed the shared `ackBatchToken`.
 */
export async function executeListeningModeTool(
  argumentsValue: Record<string, unknown>,
  operation: ListeningModeOperationPort,
): Promise<McpToolResult | null> {
  if (!plainObject(argumentsValue)) return null;
  const { action, ...rest } = argumentsValue;
  let outcome: ListeningModeOutcome;
  if (action === 'get') {
    if (Object.keys(rest).length !== 0) return null;
    outcome = await operation.get();
  } else if (action === 'set') {
    try {
      outcome = await operation.set(parseSetRequest(rest));
    } catch (error) {
      if (error instanceof CliError && error.code === 'invalid_arguments') return null;
      throw error;
    }
  } else {
    return null;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome) }],
    structuredContent: outcome,
    ...(outcome.kind === 'view' || outcome.kind === 'applied' ? {} : { isError: true }),
  };
}

export type ListeningModeToolDefinition = Readonly<{
  name: typeof LISTENING_MODE_TOOL_NAME;
  description: string;
  inputSchema: Readonly<{
    type: 'object';
    properties: Readonly<Record<string, unknown>>;
    required: readonly string[];
    additionalProperties: false;
  }>;
}>;

export function listeningModeToolDefinition(): ListeningModeToolDefinition {
  return {
    name: LISTENING_MODE_TOOL_NAME,
    description: 'Inspect or change the listening mode of the binding held by this agent; no other binding can be targeted. Call action "get" first, then action "set" with requested and the exact version as expectedVersion. A conflict means someone else changed the mode: call get again and decide afresh; never retry automatically. requested and effective may differ, and support reasons explain why. Neither proves that any message was or will be delivered, including while this agent is idle. Valid results may append untrusted channel batch data; echo its exact batchToken as ackBatchToken on the next independently intended Khala call.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get inspects; set changes the requested mode.' },
        requested: { type: 'string', enum: [...LISTENING_MODES], description: 'set only: the mode to request.' },
        expectedVersion: {
          type: 'integer', minimum: 0, description: 'set only: the version returned by the latest get.',
        },
        ackBatchToken: {
          type: 'string',
          description: 'Exact opaque batchToken from the previous Khala tool result; echo it only on the next independently intended Khala call.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };
}
