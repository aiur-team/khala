// Raw process list for the trial record: pid, parent pid, and argv for every
// process the person can see. The verifier derives every census fact from this
// list, never from counts the person types.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

function linuxProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm sits in parentheses and may itself contain spaces or parentheses.
    const close = stat.lastIndexOf(')');
    const ppid = Number(stat.slice(close + 2).split(' ')[1]);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const argv = cmdline ? cmdline.replace(/\0$/, '').split('\0') : [`[${stat.slice(stat.indexOf('(') + 1, close)}]`];
    return { pid, ppid, argv };
  } catch {
    return null; // Exited between readdir and read.
  }
}

export function listProcesses() {
  if (process.platform === 'linux') {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).map(linuxProcess).filter(Boolean);
  }
  // ps joins argv with spaces, so an argument containing a space is split here.
  return execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [pid, ppid, ...argv] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), argv };
  });
}

export function ancestry(pid, processes) {
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const chain = [];
  for (let next = byPid.get(byPid.get(pid)?.ppid); next && !chain.includes(next); next = byPid.get(next.ppid)) chain.push(next);
  return chain;
}
