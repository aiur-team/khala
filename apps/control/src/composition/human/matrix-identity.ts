import { decodeOwnerId, type OwnerId } from '@khala/contracts/messaging/index';

/**
 * Keep legacy base64url localparts that are already lowercase. Synapse folds
 * uppercase registration usernames to lowercase, so escape each uppercase
 * base64url character with `=` before registering a new account. Base64url
 * never contains `=`, making the mapping reversible without case collisions.
 */
export function ownerMatrixLocalpart(ownerId: OwnerId): string {
  const encoded = Buffer.from(ownerId, 'utf8').toString('base64url');
  return `khala_${encoded.replace(/[A-Z]/gu, letter => `=${letter.toLowerCase()}`)}`;
}

export function ownerMatrixUserId(ownerId: OwnerId, serverName: string): string {
  return `@${ownerMatrixLocalpart(ownerId)}:${serverName}`;
}

/** Only the exact reversible encoding can establish a participant's owner. */
export function ownerFromMatrixUserId(userId: string, serverName: string): OwnerId | null {
  const suffix = `:${serverName}`;
  if (!userId.startsWith('@khala_') || !userId.endsWith(suffix)) return null;
  const encoded = userId.slice('@khala_'.length, -suffix.length);
  if (!/^(?:[a-z0-9_-]|=[a-z])+$/u.test(encoded)) return null;
  const raw = encoded.replace(/=([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  const candidate = Buffer.from(raw, 'base64url').toString('utf8');
  const owner = decodeOwnerId(candidate);
  return owner.ok && ownerMatrixUserId(owner.value, serverName) === userId ? owner.value : null;
}
