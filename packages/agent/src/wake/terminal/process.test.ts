import { beforeEach, expect, it, vi } from 'vitest';
const kernel = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => kernel);
import { ownsTerminal } from './process';
const signal = new AbortController().signal;
it.each([['ttys001 42 42', '/dev/ttys001', true], ['ttys001 42 43', '/dev/ttys001', false], ['ttys002 42 42', '/dev/ttys001', false], ['? 42 42', '/dev/ttys001', false], ['ttys001 0 0', '/dev/ttys001', false], ['junk', '/dev/ttys001', false]])('mac tty/foreground ownership %s', async (output, tty, expected) => {
 const run = vi.fn(async () => output);
 expect(await ownsTerminal(123, tty, {}, signal, run, 'darwin')).toBe(expected);
 expect(run).toHaveBeenCalledWith('ps', ['-o', 'tty=,pgid=,tpgid=', '-p', '123'], { LC_ALL: 'C' }, signal);
});
it('invalid ids, invalid tty and absent process fail closed', async () => {
 const run = vi.fn(async () => { throw new Error('gone'); });
 expect(await ownsTerminal(0, '/dev/ttys001', {}, signal, run, 'darwin')).toBe(false);
 expect(await ownsTerminal(123, '/dev/evil;cmd', {}, signal, run, 'darwin')).toBe(false);
 expect(run).not.toHaveBeenCalled();
 expect(await ownsTerminal(123, '/dev/ttys001', {}, signal, run, 'darwin')).toBe(false);
});

// /proc stat fields begin with state, ppid, pgrp, session, tty_nr, tpgid.
// Parentheses inside comm are legal and must not shift the field positions.
const procStat = (ttyNr: number, pgid = 42, tpgid = 42) => `123 (agent (worker)) S 1 ${pgid} 42 ${ttyNr} ${tpgid} 0 0 0 0`;
const device = (major: bigint, minor: bigint) => (major << 8n) | (minor & 255n) | ((minor & ~255n) << 12n);
beforeEach(() => { kernel.readFile.mockReset(); kernel.stat.mockReset(); });
it.each([
 [136n, 7n, 34823],
 // Large minor makes tty_nr signed in /proc while stat reports unsigned dev_t.
 [136n, 524295n, -2147448825],
])('Linux matches device %s:%s and foreground process group', async (major, minor, ttyNr) => {
 kernel.readFile.mockResolvedValue(procStat(ttyNr));
 kernel.stat.mockResolvedValue({ rdev: device(major, minor), isCharacterDevice: () => true });
 expect(await ownsTerminal(123, '/dev/pts/7', {}, signal, undefined, 'linux')).toBe(true);
 expect(kernel.readFile).toHaveBeenCalledWith('/proc/123/stat', 'utf8');
 expect(kernel.stat).toHaveBeenCalledWith('/dev/pts/7', { bigint: true });
});
it.each([
 ['another tty', procStat(34824), true],
 ['no controlling tty', procStat(0), true],
 ['background agent', procStat(34823, 42, 43), true],
 ['zero process group', procStat(34823, 0, 0), true],
 ['malformed proc record', 'invalid fields', true],
 ['ordinary file', procStat(34823), false],
])('Linux refuses %s', async (_reason, record, characterDevice) => {
 kernel.readFile.mockResolvedValue(record);
 kernel.stat.mockResolvedValue({ rdev: device(136n, 7n), isCharacterDevice: () => characterDevice });
 expect(await ownsTerminal(123, '/dev/pts/7', {}, signal, undefined, 'linux')).toBe(false);
});
it.each(['process', 'tty'])('Linux fails closed when %s disappears', async absent => {
 kernel.readFile.mockResolvedValue(procStat(34823));
 kernel.stat.mockResolvedValue({ rdev: device(136n, 7n), isCharacterDevice: () => true });
 if (absent === 'process') kernel.readFile.mockRejectedValue(new Error('ENOENT'));
 else kernel.stat.mockRejectedValue(new Error('ENOENT'));
 expect(await ownsTerminal(123, '/dev/pts/7', {}, signal, undefined, 'linux')).toBe(false);
});
