import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

export type CommandRunner = (command: string, argv: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<string>;
const exec = promisify(execFile);
export const runTerminalCommand: CommandRunner = async (command, argv, env, signal) => {
  const { stdout } = await exec(command, [...argv], { env, signal, timeout: 5000, maxBuffer: 1024 * 1024, shell: false });
  return stdout;
};

/** Kernel identity, never pane title/CWD; a background agent must not type into a foreground shell. */
export async function ownsTerminal(pid: number, tty: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
  run: CommandRunner = runTerminalCommand, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\/dev\/(?:pts\/\d+|tty[^\s/]+)$/.test(tty)) return false;
  try {
    if (platform === 'linux') {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      const pgid = Number(fields[2]), ttyNr = Number(fields[4]) >>> 0, tpgid = Number(fields[5]);
      const device = await stat(tty, { bigint: true });
      if (!device.isCharacterDevice()) return false;
      // Linux dev_t -> the 32-bit new_encode_dev used by /proc's tty_nr.
      const major = (device.rdev >> 8n) & 0xfffn;
      const minor = (device.rdev & 0xffn) | ((device.rdev >> 12n) & 0xffffff00n);
      const encoded = Number((major << 8n) | (minor & 0xffn) | ((minor & ~0xffn) << 12n)) >>> 0;
      return ttyNr !== 0 && ttyNr === encoded && pgid > 0 && pgid === tpgid;
    }
    if (platform === 'darwin') {
      const output = await run('ps', ['-o', 'tty=,pgid=,tpgid=', '-p', String(pid)], { ...env, LC_ALL: 'C' }, signal);
      const match = /^\s*(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(output);
      return !!match && `/dev/${match[1]}` === tty && Number(match[2]) > 0 && match[2] === match[3];
    }
  } catch { /* Missing processes, inaccessible TTYs and unsupported queries fail closed. */ }
  return false;
}
