// The signed-in human's profile for every screen below the ready shell: the
// username gate, and the settings that change it later.

import type { HumanColorId } from '@khala/contracts/m1/colors';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ProfilePort } from './ports';
import { createProfileStore, type ProfileInitialsSaveResult, type ProfileColorSaveResult, type ProfileSaveResult, type ProfileStatus, type ProfileStore } from './store';

export type { ProfileInitialsSaveResult, ProfileColorSaveResult, ProfileSaveResult, ProfileStatus } from './store';

export type ProfileValue = Readonly<{
  status: ProfileStatus;
  username: string | null;
  suggestion: string;
  color: HumanColorId | null;
  initials: string | null;
  saveInitials(initials: string | null): Promise<ProfileInitialsSaveResult>;
  saveColor(color: HumanColorId): Promise<ProfileColorSaveResult>;
  save(username: string): Promise<ProfileSaveResult>;
  retry(): void;
}>;

const ProfileContext = createContext<ProfileStore | null>(null);
const missing = createProfileStore(undefined);

/** Binds an existing store; `ProfileProvider` is the production entry. */
export function ProfileStoreProvider({ store, children }: Readonly<{ store: ProfileStore; children: ReactNode }>) {
  return <ProfileContext.Provider value={store}>{children}</ProfileContext.Provider>;
}

/** Loads the profile once per mount; key it by owner so a new sign-in loads again. */
export function ProfileProvider({ ports, children }: Readonly<{ ports: Readonly<{ profile?: ProfilePort }>; children: ReactNode }>) {
  const [store] = useState(() => createProfileStore(ports.profile));
  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);
  return <ProfileStoreProvider store={store}>{children}</ProfileStoreProvider>;
}

/** The profile; outside a provider it reads as an `error` that saves nothing. */
export function useProfile(): ProfileValue {
  const store = useContext(ProfileContext) ?? missing;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...snapshot, save: store.save, saveColor: store.saveColor, saveInitials: store.saveInitials, retry: store.retry };
}
