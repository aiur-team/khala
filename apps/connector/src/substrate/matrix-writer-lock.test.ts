import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireMatrixWriterLock, MatrixWriterLockError, parseLinuxProcessStart } from './matrix-writer-lock';

let root: string | null = null;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });
async function directory() {
  root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-writer-lock-'));
  return root;
}

it('uses fail-safe exclusive creation on macOS without inspecting Linux process state', async () => {
  const dir = await directory();
  const file = path.join(dir, 'writer.lock');
  const lock = await acquireMatrixWriterLock(dir, 'darwin');
  expect(lock.diagnostic).toEqual({ kind: 'acquired' });
  await expect(acquireMatrixWriterLock(dir, 'darwin')).rejects.toMatchObject({ code: 'ownership_uncertain' });
  await lock.close();
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(file, '2147483647');
  await expect(acquireMatrixWriterLock(dir, 'darwin')).rejects.toMatchObject({ code: 'ownership_uncertain' });
  expect(await readFile(file, 'utf8')).toBe('2147483647');
});

describe.skipIf(process.platform !== 'linux')('Matrix profile writer lock', () => {
  it('treats malformed process stat as uncertain rather than a dead owner', async () => {
    const live = await readFile(`/proc/${process.pid}/stat`, 'utf8');
    expect(parseLinuxProcessStart(live)).toMatch(/^\d+$/u);
    const end = live.lastIndexOf(')');
    const fields = live.slice(end + 2).trim().split(/\s+/u);
    for (const malformed of [live.slice(0, end), `${live.slice(0, end + 2)}S`,
      `${live.slice(0, end + 2)}${fields.slice(0, 19).join(' ')}`,
      `${live.slice(0, end + 2)}${[...fields.slice(0, 19), 'bad', ...fields.slice(20)].join(' ')}`]) {
      expect(() => parseLinuxProcessStart(malformed)).toThrowError(MatrixWriterLockError);
      try { parseLinuxProcessStart(malformed); } catch (error) {
        expect(error).toMatchObject({ code: 'ownership_uncertain' });
      }
    }
  });
  it('recovers a dead legacy owner and reports recovery without disclosing the profile', async () => {
    const dir = await directory();
    await writeFile(path.join(dir, 'writer.lock'), '2147483647', { mode: 0o600 });
    const lock = await acquireMatrixWriterLock(dir);
    expect(lock.diagnostic).toEqual({ kind: 'stale_recovered' });
    expect(await readFile(path.join(dir, 'writer.lock'), 'utf8')).toContain(`"pid":${process.pid}`);
    await lock.close();
    await expect(readFile(path.join(dir, 'writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a live owner and a reused PID without exposing owner data', async () => {
    const dir = await directory();
    const held = await acquireMatrixWriterLock(dir);
    const raw = await readFile(path.join(dir, 'writer.lock'), 'utf8');
    await expect(acquireMatrixWriterLock(dir)).rejects.toMatchObject({ code: 'active_writer' });
    expect(await readFile(path.join(dir, 'writer.lock'), 'utf8')).toBe(raw);
    await held.close();
    await writeFile(path.join(dir, 'writer.lock'), String(process.pid));
    await expect(acquireMatrixWriterLock(dir)).rejects.toMatchObject({ code: 'active_writer' });
    const reused = { ...JSON.parse(raw) as Record<string, unknown>, start: '0' };
    await writeFile(path.join(dir, 'writer.lock'), JSON.stringify(reused));
    const recovered = await acquireMatrixWriterLock(dir);
    expect(recovered.diagnostic.kind).toBe('stale_recovered');
    await recovered.close();
    expect(new MatrixWriterLockError('active_writer').message).toBe('matrix_writer_lock_active_writer');
  });

  it('does not disturb a live legacy writer and recovers it only after process exit', async () => {
    const dir = await directory();
    const file = path.join(dir, 'writer.lock');
    const child = spawn(process.execPath, ['-e',
      'const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "wx", 0o600); fs.writeSync(fd, String(process.pid)); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
      file], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', data => String(data).includes('READY') ? resolve() : reject(new Error('child_not_ready')));
        child.once('error', reject);
        child.once('exit', () => reject(new Error('child_exited_before_lock')));
      });
      const owned = await readFile(file, 'utf8');
      await expect(acquireMatrixWriterLock(dir)).rejects.toMatchObject({ code: 'active_writer' });
      expect(await readFile(file, 'utf8')).toBe(owned);
    } finally {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
    const recovered = await acquireMatrixWriterLock(dir);
    expect(recovered.diagnostic).toEqual({ kind: 'stale_recovered' });
    await recovered.close();
  });

  it('admits only one simultaneous contender', async () => {
    const dir = await directory();
    await writeFile(path.join(dir, 'writer.lock'), '2147483647');
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireMatrixWriterLock(dir)));
    const accepted = attempts.filter(result => result.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(7);
    if (accepted[0]?.status === 'fulfilled') await accepted[0].value.close();
  });

  it('leaves an unrecognised owner untouched and returns a fixed diagnostic', async () => {
    const dir = await directory();
    await writeFile(path.join(dir, 'writer.lock'), 'owner-unreadable');
    await expect(acquireMatrixWriterLock(dir)).rejects.toMatchObject({
      code: 'ownership_uncertain', message: 'matrix_writer_lock_ownership_uncertain',
    });
    expect(await readFile(path.join(dir, 'writer.lock'), 'utf8')).toBe('owner-unreadable');
  });

  it('reclaims a lock after a real child crashes', async () => {
    const dir = await directory();
    const module = fileURLToPath(new URL('./matrix-writer-lock.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      'const { acquireMatrixWriterLock } = await import(process.argv[1]); await acquireMatrixWriterLock(process.argv[2]); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
      module, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', data => String(data).includes('READY') ? resolve() : reject(new Error('child_not_ready')));
        child.once('error', reject);
        child.once('exit', () => reject(new Error('child_exited_before_lock')));
      });
      await expect(acquireMatrixWriterLock(dir)).rejects.toMatchObject({ code: 'active_writer' });
    } finally {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
    const recovered = await acquireMatrixWriterLock(dir);
    expect(recovered.diagnostic).toEqual({ kind: 'stale_recovered' });
    await recovered.close();
  });

  it('leaves no lock after a child closes normally and exits', async () => {
    const dir = await directory();
    const module = fileURLToPath(new URL('./matrix-writer-lock.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      'const { acquireMatrixWriterLock } = await import(process.argv[1]); const lock = await acquireMatrixWriterLock(process.argv[2]); await lock.close();',
      module, dir], { stdio: 'ignore' });
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    expect(code).toBe(0);
    await expect(readFile(path.join(dir, 'writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
