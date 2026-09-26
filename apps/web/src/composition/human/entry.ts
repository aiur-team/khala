import type { ShellMode } from '../../shell/types';

export const MOUNT_MODE_PARAM = 'mount';

export type EntryLocation = Readonly<{ pathname: string; search: string }>;

export type HumanEntry = Readonly<{
  mode: ShellMode;
  /** Application path with the entry-only mount parameter removed. */
  path: string;
}>;

/**
 * Reads the boot-time shell mode from `?mount=` and strips it from the path
 * handed to the router, so the parameter never makes a route unmatchable.
 * Anything other than an exact `hosted-content` value boots standalone.
 */
export function readHumanEntry(location: EntryLocation): HumanEntry {
  const params = new URLSearchParams(location.search);
  const requested = params.getAll(MOUNT_MODE_PARAM);
  const mode: ShellMode = requested.length === 1 && requested[0] === 'hosted-content' ? 'hosted-content' : 'standalone';
  params.delete(MOUNT_MODE_PARAM);
  const search = params.toString();
  return { mode, path: `${location.pathname}${search ? `?${search}` : ''}` };
}
