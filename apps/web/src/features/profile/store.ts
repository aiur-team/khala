// The signed-in human's profile, loaded once from `ProfilePort`: whether they
// have chosen a username yet, and the server's suggestion when they have not.

import type { HumanColorId } from '@khala/contracts/m1/colors';
import type { ProfilePort } from './ports';

export type ProfileStatus = 'loading' | 'ready' | 'error';
export type ProfileSnapshot = Readonly<{ status: ProfileStatus; username: string | null; suggestion: string; color: HumanColorId | null }>;
export type ProfileColorSaveResult = Awaited<ReturnType<ProfilePort['setColor']>>;
export type ProfileSaveResult = Awaited<ReturnType<ProfilePort['setUsername']>>;

export interface ProfileStore {
  getSnapshot(): ProfileSnapshot;
  subscribe(listener: () => void): () => void;
  /** Starts the load; a disposed store started again (StrictMode) loads afresh. */
  start(): void;
  retry(): void;
  save(username: string): Promise<ProfileSaveResult>;
  saveColor(color: HumanColorId): Promise<ProfileColorSaveResult>;
  dispose(): void;
}

const unavailable: Extract<ProfileSaveResult, { kind: 'error' }> = { kind: 'error', code: 'unavailable' };

/** Without a port the store is in `error` from the start, so the gate fails open. */
export function createProfileStore(port: ProfilePort | undefined): ProfileStore {
  let snapshot: ProfileSnapshot = { status: port ? 'loading' : 'error', username: null, suggestion: '', color: null };
  let loading: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ProfileSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  function load() {
    if (!port || loading) return;
    const controller = new AbortController();
    loading = controller;
    const settle = (next: ProfileSnapshot) => {
      if (loading !== controller) return;
      loading = null;
      set(next);
    };
    port.get(controller.signal).then(
      result => settle(result.kind === 'ok'
        ? { status: 'ready', username: result.username, suggestion: result.suggestion, color: result.color }
        : { ...snapshot, status: 'error' }),
      () => settle({ ...snapshot, status: 'error' }),
    );
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (snapshot.status === 'loading') load();
    },
    retry() {
      if (!port || snapshot.status !== 'error') return;
      set({ ...snapshot, status: 'loading' });
      load();
    },
    async save(username) {
      if (!port) return unavailable;
      let result: ProfileSaveResult;
      try {
        result = await port.setUsername(username);
      } catch {
        return unavailable;
      }
      if (result.kind === 'ok') set({ ...snapshot, status: 'ready', username: result.username });
      return result;
    },
    async saveColor(color) {
      if (!port) return unavailable;
      let result: ProfileColorSaveResult;
      try {
        result = await port.setColor(color);
      } catch {
        return unavailable;
      }
      if (result.kind === 'ok') set({ ...snapshot, status: 'ready', color: result.color });
      return result;
    },
    dispose() {
      loading?.abort();
      loading = null;
    },
  };
}
