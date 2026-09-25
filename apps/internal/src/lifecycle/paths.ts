import { createHash } from 'node:crypto';
import path from 'node:path';

// Channel IDs are opaque strings and never become path components. Every ID maps
// to one fixed-length digest segment below `<root>/channels`, so separators,
// dot segments, Unicode and length cannot escape or alias another channel.

export const CHANNELS_DIRECTORY = 'channels';
const DIRECTORY_DOMAIN = 'khala.internal.channel-directory.v1\0';
const MAX_CHANNEL_ID_LENGTH = 1_024;

export function isLifecycleChannelId(channelId: unknown): channelId is string {
  return typeof channelId === 'string' && channelId.length > 0 && channelId.length <= MAX_CHANNEL_ID_LENGTH
    && !channelId.includes('\0') && !/\p{Cs}/u.test(channelId);
}

/** 43-character base64url SHA-256 of the domain-separated UTF-8 channel ID. */
export function channelDirectorySegment(channelId: string): string {
  return createHash('sha256').update(DIRECTORY_DOMAIN).update(channelId, 'utf8').digest('base64url');
}

export function isNormalAbsolute(target: string): boolean {
  return path.isAbsolute(target) && path.resolve(target) === target;
}

/** Returns `null` for a relative/non-normal root or an unusable channel ID. */
export function channelDirectory(root: string, channelId: string): string | null {
  if (!isNormalAbsolute(root) || !isLifecycleChannelId(channelId)) return null;
  return path.join(root, CHANNELS_DIRECTORY, channelDirectorySegment(channelId));
}
