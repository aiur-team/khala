// Pure XDG/PATH resolution for setup. Every value comes from the injected inputs; nothing
// here reads the process environment, consults the working directory, or touches the disk.
import path from 'node:path';

export type SetupPathInputs = Readonly<{
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
  XDG_STATE_HOME?: string;
  /** Codex's own config root override; defaults to `$HOME/.codex`. */
  CODEX_HOME?: string;
  PATH?: string;
}>;

export type SetupPaths = Readonly<{
  home: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  codexHome: string;
  versionsRoot: string;
  binRoot: string;
  manifestPath: string;
  transactionPath: string;
  backupsRoot: string;
  /** The runtime descriptor owned by the loopback server. Setup names it and never reads its contents. */
  runtimeDescriptorPath: string;
  /** Distinct absolute PATH directories in order. Empty, dot, and relative entries are dropped, never resolved. */
  pathEntries: readonly string[];
}>;

export type SetupPathErrorCode =
  | 'invalid_home' | 'invalid_xdg_config_home' | 'invalid_xdg_data_home' | 'invalid_xdg_state_home' | 'invalid_codex_home';

export class SetupPathError extends Error {
  constructor(readonly code: SetupPathErrorCode) {
    super(code);
    this.name = 'SetupPathError';
  }
}

function absolute(value: string, code: SetupPathErrorCode): string {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new SetupPathError(code);
  return path.normalize(value);
}

// The XDG spec treats an empty variable as unset; a relative one is invalid and fails closed.
function xdgRoot(value: string | undefined, fallback: string, code: SetupPathErrorCode): string {
  return value === undefined || value === '' ? fallback : absolute(value, code);
}

function pathEntries(value: string | undefined): readonly string[] {
  const entries = new Set<string>();
  for (const entry of (value ?? '').split(path.delimiter)) {
    if (path.isAbsolute(entry) && !entry.includes('\0')) entries.add(path.resolve(entry));
  }
  return [...entries];
}

export function resolveSetupPaths(input: SetupPathInputs): SetupPaths {
  const home = absolute(input.HOME ?? '', 'invalid_home');
  const configHome = xdgRoot(input.XDG_CONFIG_HOME, path.join(home, '.config'), 'invalid_xdg_config_home');
  const dataHome = xdgRoot(input.XDG_DATA_HOME, path.join(home, '.local', 'share'), 'invalid_xdg_data_home');
  const stateHome = xdgRoot(input.XDG_STATE_HOME, path.join(home, '.local', 'state'), 'invalid_xdg_state_home');
  // Codex treats an empty CODEX_HOME as unset too; a relative one fails closed like XDG.
  const codexHome = xdgRoot(input.CODEX_HOME, path.join(home, '.codex'), 'invalid_codex_home');
  const khalaData = path.join(dataHome, 'khala');
  const setupState = path.join(stateHome, 'khala', 'setup');
  return {
    home,
    configHome,
    dataHome,
    stateHome,
    codexHome,
    versionsRoot: path.join(khalaData, 'versions'),
    binRoot: path.join(khalaData, 'bin'),
    manifestPath: path.join(setupState, 'manifest.v1.json'),
    transactionPath: path.join(setupState, 'transaction.v1.json'),
    backupsRoot: path.join(setupState, 'backups'),
    runtimeDescriptorPath: path.join(stateHome, 'khala', 'internal', 'active.json'),
    pathEntries: pathEntries(input.PATH),
  };
}
