import { afterEach, describe, expect, it, vi } from 'vitest';
import { ancestors, cachedProcessReader, nearestNonShellAncestor, parseDarwinPs, parseLinuxStat, parseWindowsCsv, readProcess } from './proc';
import type { ProcessInfo, ProcessReader } from './proc';

function tree(rows: ProcessInfo[]): ProcessReader {
  return async pid => rows.find(row => row.pid === pid) ?? null;
}

describe('process inspection', () => {
  it('reads Linux start time after commands containing spaces and parentheses', () => {
    const fields = ['S', '100', ...Array<string>(17).fill('0'), '987654'];
    expect(parseLinuxStat(300, `300 (hook (worker)) ${fields.join(' ')}`)).toEqual({ pid: 300, ppid: 100, startTime: '987654', command: 'hook (worker)' });
    expect(parseLinuxStat(301, `300 (hook) ${fields.join(' ')}`)).toBeNull();
    expect(parseLinuxStat(300, '300 (hook) S 100')).toBeNull();
    for (const state of ['Z', 'X']) expect(parseLinuxStat(300, `300 (hook) ${[state, ...fields.slice(1)].join(' ')}`)).toBeNull();
  });
  it('parses macOS ps output into a stable session-safe token', () => {
    expect(parseDarwinPs(400, ' 100 Mon Oct  5 12:34:56 2026 /Applications/Gemini App/gemini\n')).toEqual({ pid: 400, ppid: 100, startTime: 'Mon-Oct-5-12-34-56-2026', command: '/Applications/Gemini App/gemini' });
    expect(parseDarwinPs(400, '')).toBeNull();
  });
  it('reads a PowerShell CSV fixture with reordered columns and escaped quotes', () => {
    const fixture = '\uFEFF"Name","CreationDate","ParentProcessId","ProcessId"\r\n"gemini, ""agent"".exe","2026-10-05T12:34:56.1234567Z","100","400"\r\n';
    expect(parseWindowsCsv(fixture, 400)).toEqual({ pid: 400, ppid: 100, startTime: '2026-10-05T12-34-56-1234567Z', command: 'gemini, "agent".exe' });
    expect(parseWindowsCsv(fixture, 500)).toBeNull();
    expect(parseWindowsCsv('"ProcessId","ParentProcessId","CreationDate","Name"\n"400","","","agent"', 400)).toBeNull();
  });
  it('walks nearest ancestors and skips shells to find the harness', async () => {
    const read = tree([
      { pid: 300, ppid: 200, startTime: '3', command: 'node' },
      { pid: 200, ppid: 100, startTime: '2', command: '/bin/zsh' },
      { pid: 100, ppid: 0, startTime: '1', command: 'gemini' },
    ]);
    expect((await ancestors(300, read)).map(row => row.pid)).toEqual([200, 100]);
    expect((await nearestNonShellAncestor(300, read))?.pid).toBe(100);
    expect(await nearestNonShellAncestor(999, read)).toBeNull();
  });
  it('stops at disappeared parents and process-tree cycles', async () => {
    expect(await ancestors(300, tree([{ pid: 300, ppid: 200, startTime: '3', command: 'node' }]))).toEqual([]);
    const read = tree([
      { pid: 300, ppid: 200, startTime: '3', command: 'node' },
      { pid: 200, ppid: 300, startTime: '2', command: 'bash' },
    ]);
    expect((await ancestors(300, read)).map(row => row.pid)).toEqual([200]);
  });
  it('rejects invalid pids without spawning platform commands', async () => {
    for (const pid of [-1, 0, NaN, Infinity, 1.5]) expect(await readProcess(pid)).toBeNull();
  });
  it.skipIf(process.platform !== 'linux')('reads the current Linux process with a stable start time', async () => {
    const first = await readProcess(process.pid);
    expect(first?.pid).toBe(process.pid);
    expect(first?.ppid).toBe(process.ppid);
    expect(first?.startTime).toMatch(/^\d+$/);
    expect((await readProcess(process.pid))?.startTime).toBe(first?.startTime);
  });
});

afterEach(() => vi.restoreAllMocks());
it('caches concurrent owner probes only within one hook', async () => {
  const identity = { pid: 42, ppid: 1, startTime: 'start', command: 'node' };
  const read = vi.fn(async () => identity);
  const cached = cachedProcessReader(read);
  expect(await Promise.all([cached(42), cached(42)])).toEqual([identity, identity]);
  expect(read).toHaveBeenCalledOnce();
  await cachedProcessReader(read)(42);
  expect(read).toHaveBeenCalledTimes(2);
});
it('skips expensive identity probes when the cheap liveness check fails', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); });
  expect(await readProcess(42)).toBeNull();
  expect(kill).toHaveBeenCalledExactlyOnceWith(42, 0);
});
it.skipIf(process.platform !== 'linux')('reads process identity when the cheap liveness check returns EPERM', async () => {
  const identity = await readProcess(process.pid);
  expect(identity?.startTime).toMatch(/^\d+$/);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); });
  expect(await readProcess(process.pid)).toEqual(identity);
  expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 0);
});
