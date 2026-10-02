import type { NameError } from '@khala/contracts/m1/names';

export type ProfileError = 'invalid_username' | 'username_taken' | 'signed_out' | 'unavailable';
export interface ProfilePort {
  get(signal?: AbortSignal): Promise<{ kind: 'ok'; username: string | null; suggestion: string } | { kind: 'error'; code: ProfileError }>;
  setUsername(username: string, signal?: AbortSignal): Promise<{ kind: 'ok'; username: string } | { kind: 'error'; code: ProfileError; reason?: NameError }>;
}
