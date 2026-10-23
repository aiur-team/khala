// Listening-mode icons and copy, shared by the roster and the mention chips.

import type { ReactNode } from 'react';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import { AsyncIcon, MuteIcon, SteerIcon, SyncIcon } from './icons';

// `KH_MODES` (source:4394): value, label, description.
export const MODE_COPY = [['steer', 'Steer', 'interrupts'], ['sync', 'Sync', 'next turn'], ['async', 'Async', 'pings only'], ['mute', 'Mute', 'silent']] as const;
const MODE_ICONS: Readonly<Record<ListeningMode, () => ReactNode>> = { steer: SteerIcon, sync: SyncIcon, async: AsyncIcon, mute: MuteIcon };
const MODE_TIPS = Object.fromEntries(MODE_COPY.map(([value, label, desc]) => [value, `${label} · ${desc}`])) as Readonly<Record<ListeningMode, string>>;

/** `Steer · interrupts` */
export const modeTip = (mode: ListeningMode) => MODE_TIPS[mode];

export function ModeIcon({ mode }: Readonly<{ mode: ListeningMode }>) {
  const Icon = MODE_ICONS[mode];
  return <Icon />;
}
