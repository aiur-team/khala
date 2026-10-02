import type { HumanColorId } from '@khala/contracts/m1/colors';
import type { NameError } from '@khala/contracts/m1/names';

export type ProfileError = 'invalid_initials' | 'invalid_color' | 'invalid_username' | 'username_taken' | 'signed_out' | 'unavailable';
export interface ProfilePort {
  get(signal?: AbortSignal): Promise<{ kind: 'ok'; username: string | null; suggestion: string; color: HumanColorId; initials: string | null } | { kind: 'error'; code: ProfileError }>;
  setUsername(username: string, signal?: AbortSignal): Promise<{ kind: 'ok'; username: string } | { kind: 'error'; code: ProfileError; reason?: NameError }>;
  setColor(color: HumanColorId, signal?: AbortSignal): Promise<{ kind: 'ok'; color: HumanColorId } | { kind: 'error'; code: ProfileError }>;
  setInitials(initials: string | null, signal?: AbortSignal): Promise<{ kind: 'ok'; initials: string | null } | { kind: 'error'; code: ProfileError }>;
}
