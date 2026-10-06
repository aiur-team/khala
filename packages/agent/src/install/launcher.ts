import type nodePath from 'node:path';

/** Stable npm launcher shared by installers and session registration hints. */
export function installedLauncher(platform: NodeJS.Platform, path: Pick<typeof nodePath, 'join' | 'isAbsolute'>, home: string, env: NodeJS.ProcessEnv): { prefix: string; bin: string } {
  const windows = platform === 'win32';
  const candidate = windows ? env.LOCALAPPDATA : env.XDG_DATA_HOME;
  const dataHome = candidate && path.isAbsolute(candidate) ? candidate
    : windows ? path.join(home, 'AppData', 'Local') : path.join(home, '.local', 'share');
  const prefix = path.join(dataHome, 'khala', 'npm');
  return { prefix, bin: windows ? path.join(prefix, 'khala.cmd') : path.join(prefix, 'bin', 'khala') };
}

/** Antigravity uses a shell command for hooks and agent registration. */
export function launcherShellQuote(platform: NodeJS.Platform, bin: string): string {
  return platform === 'win32' ? `"${bin}"` : `'${bin.replaceAll("'", `'\\''`)}'`;
}
