import { type Decoded, decodeWith, fail, identifier, literal, nullable, object, utcTimestamp, version } from '../messaging/decode';
import { readMatrixUserId } from './agent-join';
import { checkName } from './names';

export type ProfileView = { username: string | null; suggestion: string };
export type ProfileRecord = { v: 1; ownerId: string; username: string; updatedAt: string };
export type NameReservation =
  | { v: 1; kind: 'human'; ownerId: string }
  | { v: 1; kind: 'agent'; ownerId: string; matrixUserId: string };
export const PROFILE_PATH = '/api/human/profile';
export const PROFILE_USERNAME_PATH = '/api/human/profile/username';
export const profileRecordKey = (ownerId: string): string => `profiles/${encodeURIComponent(ownerId)}`;

function readUsername(input: unknown, path: string): string {
  const value = identifier(input, path);
  const checked = checkName(value, 'username');
  if (!checked.ok || checked.name !== value) fail(path, 'invalid_value');
  return value;
}
export function decodeProfileView(input: unknown): Decoded<ProfileView> {
  return decodeWith(() => {
    const r = object(input, '', ['username', 'suggestion']);
    return { username: nullable(r.field('username'), value => readUsername(value, r.at('username'))),
      suggestion: readUsername(r.field('suggestion'), r.at('suggestion')) };
  });
}
export function decodeProfileRecord(input: unknown): Decoded<ProfileRecord> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'ownerId', 'username', 'updatedAt']);
    return { v: version(r.field('v'), r.at('v')), ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
      username: readUsername(r.field('username'), r.at('username')), updatedAt: utcTimestamp(r.field('updatedAt'), r.at('updatedAt')) };
  });
}
export function decodeNameReservation(input: unknown): Decoded<NameReservation> {
  return decodeWith(() => {
    const kind = literal((input as Record<string, unknown> | null)?.['kind'], 'kind', ['human', 'agent']);
    const r = object(input, '', kind === 'human' ? ['v', 'kind', 'ownerId'] : ['v', 'kind', 'ownerId', 'matrixUserId']);
    const common = { v: version(r.field('v'), r.at('v')), ownerId: identifier(r.field('ownerId'), r.at('ownerId')) };
    return kind === 'human' ? { ...common, kind } : { ...common, kind,
      matrixUserId: readMatrixUserId(r.field('matrixUserId'), r.at('matrixUserId')) };
  });
}
