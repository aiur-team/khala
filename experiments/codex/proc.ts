/** Linux /proc observations and process-group control for the live driver. */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** PID holding the native thread-writer flock, read from /proc/locks. */
export function lockHolder(threadId: string, home = homedir()): number | null {
  const lock = join(home, '.codex', 'thread-writer-locks', `${threadId}.lock`);
  if (!existsSync(lock)) return null;
  const inode = statSync(lock).ino;
  for (const line of readFileSync('/proc/locks', 'utf8').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[1] === 'FLOCK' && f[3] === 'WRITE' && f[5]?.split(':')[2] === String(inode)) return Number(f[4]);
  }
  return null;
}

/** PID owning the listening Unix socket at `path`, via /proc/net/unix and /proc/<pid>/fd. */
export function socketListenerPid(path: string): number | null {
  const inode = readFileSync('/proc/net/unix', 'utf8').split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(f => f[7] === path && f[3] === '00010000')?.[6];
  if (!inode) return null;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        if (readlinkSync(`/proc/${entry}/fd/${fd}`) === `socket:[${inode}]`) return Number(entry);
      }
    } catch { /* exited or not ours */ }
  }
  return null;
}

/** Live PIDs whose process group is `pgid`, from /proc/<pid>/stat. */
export function groupPids(pgid: number): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) === pgid) pids.push(Number(entry));
    } catch { /* exited while scanning */ }
  }
  return pids;
}

/** Live PIDs whose command line contains `needle`, from /proc/<pid>/cmdline. */
export function pidsMatching(needle: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ').includes(needle)) pids.push(Number(entry));
    } catch { /* exited while scanning */ }
  }
  return pids;
}

/**
 * Stop a child started with `detached: true` and its whole process group: the
 * `codex` launcher execs a separate native binary that must not outlive it.
 */
export async function stopProcess(child: ChildProcess, graceMs = 10_000): Promise<{ code: number | null; signal: string | null; groupEmpty: boolean }> {
  const pgid = child.pid!;
  const signalGroup = (s: NodeJS.Signals) => { try { process.kill(-pgid, s); } catch { /* group already gone */ } };
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
    : new Promise<void>(r => child.once('exit', () => r()));
  signalGroup('SIGTERM');
  const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
  await exited;
  for (let i = 0; i < graceMs / 100 && groupPids(pgid).length; i++) await sleep(100);
  clearTimeout(timer);
  if (groupPids(pgid).length) { signalGroup('SIGKILL'); await sleep(500); }
  return { code: child.exitCode, signal: child.signalCode, groupEmpty: groupPids(pgid).length === 0 };
}
