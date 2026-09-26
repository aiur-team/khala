// Process identity for the setup lock. A pid alone is not an identity: after a crash and reboot
// an unrelated process can reuse it. The lock therefore also records the boot id and the
// process start time, and a holder is live only when all three still match.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export type LockIdentity = Readonly<{ pid: number; bootId: string | null; startTime: string | null }>;

/** Linux: the kernel's per-boot random id. macOS: the boot session uuid, else the boot time. */
export function currentBootId(): string | null {
  try {
    if (process.platform === 'linux') return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    if (process.platform === 'darwin') {
      for (const key of ['kern.bootsessionuuid', 'kern.boottime']) {
        try {
          const value = execFileSync('sysctl', ['-n', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (value !== '') return value;
        } catch { /* try the next key */ }
      }
    }
  } catch { /* unavailable */ }
  return null;
}

/** An opaque, stable-for-the-process-lifetime start marker, or null when it cannot be read. */
export function processStartTime(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The comm field may contain spaces and parentheses; fields resume after the last ')'.
      // starttime is field 22, i.e. index 19 after state (field 3).
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] ?? null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

export function currentLockIdentity(): LockIdentity {
  return { pid: process.pid, bootId: currentBootId(), startTime: processStartTime(process.pid) };
}

/**
 * Whether the recorded holder is still the same running process. A recorded field that
 * cannot be compared (legacy pid-only record, or an unreadable current value) does not prove
 * staleness, so the holder is kept live rather than stolen from.
 */
export function holderIsLive(holder: LockIdentity, pidAlive: (pid: number) => boolean): boolean {
  if (!pidAlive(holder.pid)) return false;
  const boot = currentBootId();
  if (holder.bootId !== null && boot !== null && holder.bootId !== boot) return false;
  const start = processStartTime(holder.pid);
  if (holder.startTime !== null && start !== null && holder.startTime !== start) return false;
  return true;
}
