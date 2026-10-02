// Holds the app behind the username setup screen until the signed-in human has
// a username. It fails open: without a profile port, or when the profile cannot
// load, the app stays usable and the username can be set later in Settings.

import type { ReactNode } from 'react';
import { useProfile } from './ProfileProvider';
import { UsernameSetupScreen, type UsernameShellProps } from './UsernameSetupScreen';

export function UsernameGate({ pending, children, ...shell }: UsernameShellProps & Readonly<{
  /** Shown while the profile loads: the shell's pending frame. */
  pending: ReactNode;
  children: ReactNode;
}>) {
  const { status, username } = useProfile();
  if (status === 'loading') return <>{pending}</>;
  if (status === 'ready' && username === null) return <UsernameSetupScreen {...shell} />;
  return <>{children}</>;
}
