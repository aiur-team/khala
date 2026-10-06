import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
}

export type ProcessReader = (pid: number) => Promise<ProcessInfo | null>;
const execFileAsync = promisify(execFile);
const validPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;

// Keep identity tokens usable in session ids without depending on local timezone.
function startToken(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
}

export function parseLinuxStat(pid: number, text: string): ProcessInfo | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (!validPid(pid) || open < 0 || close < open || Number(text.slice(0, open).trim()) !== pid) return null;
  // The command can contain spaces and parentheses. Field 3 starts after its final ).
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (fields[0] === 'Z' || fields[0] === 'X') return null;
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !startTime || !/^\d+$/.test(startTime)) return null;
  return { pid, ppid, startTime, command: text.slice(open + 1, close) };
}

export function parseDarwinPs(pid: number, text: string): ProcessInfo | null {
  const match = text.trim().match(/^(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!validPid(pid) || !match) return null;
  return { pid, ppid: Number(match[1]), startTime: startToken(match[2]!), command: match[3]! };
}

function csvFields(line: string): string[] | null {
  const fields: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(value); value = ''; }
    else value += char;
  }
  if (quoted) return null;
  fields.push(value);
  return fields;
}

export function parseWindowsCsv(text: string, pid: number): ProcessInfo | null {
  if (!validPid(pid)) return null;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  const headers = csvFields(lines[0] ?? '');
  if (!headers) return null;
  for (const line of lines.slice(1)) {
    const values = csvFields(line);
    if (!values) continue;
    const field = (name: string): string => values[headers.indexOf(name)] ?? '';
    if (Number(field('ProcessId')) !== pid) continue;
    const ppid = Number(field('ParentProcessId'));
    const startTime = startToken(field('CreationDate'));
    const command = field('Name');
    if (!field('ParentProcessId') || !Number.isSafeInteger(ppid) || ppid < 0 || !startTime || !command) return null;
    return { pid, ppid, startTime, command };
  }
  return null;
}

export async function readProcess(pid: number): Promise<ProcessInfo | null> {
  if (!validPid(pid)) return null;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return parseLinuxStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8'));
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'ppid=,lstart=,comm=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
      return parseDarwinPs(pid, stdout);
    }
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},Name | ConvertTo-Csv -NoTypeInformation`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 });
      return parseWindowsCsv(stdout, pid);
    }
  } catch { /* A process can disappear or be inaccessible during any probe. */ }
  return null;
}

export async function* walkAncestors(pid: number, read: ProcessReader = readProcess): AsyncGenerator<ProcessInfo> {
  const seen = new Set<number>([pid]);
  let current = await read(pid);
  while (current && validPid(current.ppid) && !seen.has(current.ppid)) {
    seen.add(current.ppid);
    current = await read(current.ppid);
    if (current) yield current;
  }
}

export async function ancestors(pid: number, read: ProcessReader = readProcess): Promise<ProcessInfo[]> {
  const result: ProcessInfo[] = [];
  for await (const parent of walkAncestors(pid, read)) result.push(parent);
  return result;
}

export async function nearestNonShellAncestor(pid: number, read: ProcessReader = readProcess): Promise<ProcessInfo | null> {
  for await (const ancestor of walkAncestors(pid, read)) {
    const name = ancestor.command.split(/[\\/]/).pop()?.replace(/^-/, '').toLowerCase() ?? '';
    if (!/^(?:sh|bash|dash|zsh|fish|ksh|csh|tcsh|ash|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/.test(name)) return ancestor;
  }
  return null;
}

/** Scope this cache to one hook invocation; long-running readers must probe afresh. */
export function cachedProcessReader(read: ProcessReader = readProcess): ProcessReader {
  const cache = new Map<number, Promise<ProcessInfo | null>>();
  return pid => {
    let result = cache.get(pid);
    if (!result) { result = read(pid); cache.set(pid, result); }
    return result;
  };
}
