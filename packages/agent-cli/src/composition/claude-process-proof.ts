import { createHash } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';

export type ClaudeProcessScope = Pick<SessionBinding,
  'bindingId' | 'generation' | 'ownerId' | 'agentParticipantId' | 'deviceId' | 'harness' | 'sessionId'>;
export type ClaudeProofOperation = 'read' | 'send' | 'end';

/** Canonical operation bytes shared by the MCP child and the owner launcher. */
export function claudeProcessBodyHash(operation: ClaudeProofOperation, body?: string): string {
  return createHash('sha256').update(JSON.stringify([operation, body ?? null])).digest('base64url');
}

export function claudeProcessProofMessage(input: Readonly<{
  scope: ClaudeProcessScope; operation: ClaudeProofOperation; bodyHash: string; challenge: string;
}>): Buffer {
  const scope = input.scope;
  return Buffer.from(JSON.stringify(['khala.claude.process.v1', 'POST', '/api/agent/claude/session', [
    scope.harness, scope.sessionId, scope.bindingId, scope.generation, scope.ownerId,
    scope.agentParticipantId, scope.deviceId,
  ], input.operation, input.bodyHash, input.challenge]));
}
