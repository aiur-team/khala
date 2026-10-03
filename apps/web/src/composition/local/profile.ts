import { decodeOwnerColorResult, decodeOwnerInitialsResult, decodeOwnerProfileView, decodeOwnerUsernameResult } from '@khala/contracts/m1/local';
import { isCanonicalInitials } from '@khala/contracts/m1/initials';
import type { NameError } from '@khala/contracts/m1/names';
import type { ProfilePort } from '../../features/profile/ports';
import { LOCAL_PROFILE_PATH, type LocalHttp } from './http';

// Stored legacy initials do not prevent the rest of the profile from loading.
const decodeProfile = (value: unknown) => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'initials' in value
    && value.initials !== null && !isCanonicalInitials(value.initials)) {
    return decodeOwnerProfileView({ ...value, initials: null });
  }
  return decodeOwnerProfileView(value);
};

export function createLocalProfilePort(http: LocalHttp, options?: { onUsername?: (username: string) => void }): ProfilePort {
  return {
    async get(signal) {
      const result = await http.get(LOCAL_PROFILE_PATH, decodeProfile, signal);
      if (result.kind === 'ok') {
        const { username, suggestion, color, initials } = result.value;
        return { kind: 'ok', username, suggestion, color, initials };
      }
      return { kind: 'error', code: result.kind === 'error' && result.status === 401 ? 'signed_out' : 'unavailable' };
    },
    async setUsername(username, signal) {
      const result = await http.send('POST', `${LOCAL_PROFILE_PATH}/username`, { username }, decodeOwnerUsernameResult, signal);
      if (result.kind === 'ok') { options?.onUsername?.(result.value.username); return { kind: 'ok', ...result.value }; }
      if (result.kind === 'error') {
        if (result.status === 401) return { kind: 'error', code: 'signed_out' };
        if (result.status === 409) return { kind: 'error', code: 'username_taken' };
        if (result.status === 400) {
          const reasons: readonly NameError[] = ['too_short', 'too_long', 'invalid_characters', 'reserved'];
          const reason = reasons.find(value => value === result.reason);
          return { kind: 'error', code: 'invalid_username', ...(reason ? { reason } : {}) };
        }
      }
      return { kind: 'error', code: 'unavailable' };
    },
    async setColor(color, signal) {
      const result = await http.send('POST', `${LOCAL_PROFILE_PATH}/color`, { color }, decodeOwnerColorResult, signal);
      if (result.kind === 'ok') return { kind: 'ok', ...result.value };
      if (result.kind === 'error' && result.status === 401) return { kind: 'error', code: 'signed_out' };
      if (result.kind === 'error' && result.status === 400) return { kind: 'error', code: 'invalid_color' };
      return { kind: 'error', code: 'unavailable' };
    },
    async setInitials(initials, signal) {
      const result = await http.send('POST', `${LOCAL_PROFILE_PATH}/initials`, { initials }, decodeOwnerInitialsResult, signal);
      if (result.kind === 'ok') return { kind: 'ok', ...result.value };
      if (result.kind === 'error' && result.status === 401) return { kind: 'error', code: 'signed_out' };
      if (result.kind === 'error' && result.status === 400) return { kind: 'error', code: 'invalid_initials' };
      return { kind: 'error', code: 'unavailable' };
    },
  };
}
