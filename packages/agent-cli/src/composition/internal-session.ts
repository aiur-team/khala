import { createHash } from 'node:crypto';

/**
 * What an internal-mode binding stores as its session: a digest of the harness and
 * its own session ID, never the raw ID. The internal server derives it when it binds a
 * discovery identity; a native hook derives it again to recognise its own session.
 */
export function internalSessionDigest(harness: string, sessionId: string): string {
  return createHash('sha256').update(['khala.internal.session.v1', harness, sessionId].join('\0')).digest('base64url');
}
