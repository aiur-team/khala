import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function sessionArgument(argv: readonly string[]): string | undefined {
  if (argv.some(arg => arg === '--fork' || arg === '--fork=true')) return undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = arg === '-s' || arg === '--session' ? argv[++index]
      : arg.startsWith('--session=') ? arg.slice('--session='.length) : undefined;
    if (value !== undefined && /^ses_[A-Za-z0-9]+$/.test(value)) return value;
  }
  return undefined;
}

async function nativeArguments(): Promise<string[]> {
  // Bun's TUI worker replaces process.argv, but shares the native process identity.
  if (process.platform === 'linux') return (await readFile('/proc/self/cmdline', 'utf8')).split('\0');
  const { stdout } = process.platform === 'win32'
    ? await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}').CommandLine`], { timeout: 5_000 })
    : await execFileAsync('ps', ['-ww', '-o', 'command=', '-p', String(process.pid)], { timeout: 5_000 });
  // Preserve quoted prompt/project arguments as single tokens, never execute them.
  return (stdout.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? []).map(arg =>
    /^(["']).*\1$/.test(arg) ? arg.slice(1, -1) : arg);
}

/** Resume only an explicitly selected session; a workspace does not identify it. */
export async function startupSession(argv: readonly string[] = process.argv,
  readArguments: () => Promise<readonly string[]> = nativeArguments): Promise<string | undefined> {
  if (argv.some(arg => arg === '--fork' || arg === '--fork=true')) return undefined;
  const direct = sessionArgument(argv);
  if (direct) return direct;
  try { return sessionArgument(await readArguments()); }
  catch { return undefined; }
}
