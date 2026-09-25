import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_LEASE_FILE, acquireRootLease } from './lock';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function makeRoot(): string {
  const base = fs.mkdtempSync(path.join('/tmp', 'khala-lease-'));
  roots.push(base);
  fs.chmodSync(base, 0o700);
  return path.join(base, 'internal');
}

describe('root runtime lease', () => {
  it('admits one owner at a time and is reusable after release', () => {
    const root = makeRoot();
    const first = acquireRootLease(root);
    expect(first.kind).toBe('acquired');
    expect(acquireRootLease(root)).toEqual({ kind: 'held' });
    expect(fs.statSync(path.join(root, ROOT_LEASE_FILE)).mode & 0o777).toBe(0o600);
    if (first.kind === 'acquired') { first.lease.release(); first.lease.release(); }
    const second = acquireRootLease(root);
    expect(second.kind).toBe('acquired');
    if (second.kind === 'acquired') second.lease.release();
  });

  it('is released by the operating system when the owning process dies', async () => {
    const root = makeRoot();
    const lockModule = fileURLToPath(new URL('./lock.ts', import.meta.url));
    const script = `import { acquireRootLease } from ${JSON.stringify(lockModule)};
      const result = acquireRootLease(${JSON.stringify(root)});
      process.stdout.write(result.kind + '\\n');
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'],
    });
    const line = await new Promise<string>(resolve => child.stdout!.once('data', chunk => resolve(String(chunk).trim())));
    expect(line).toBe('acquired');
    expect(acquireRootLease(root)).toEqual({ kind: 'held' });
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const after = acquireRootLease(root);
    expect(after.kind).toBe('acquired');
    if (after.kind === 'acquired') after.lease.release();
  }, 30_000);

  it('refuses a symlinked or shared lease file', () => {
    const root = makeRoot();
    fs.mkdirSync(root, { mode: 0o700 });
    const target = path.join(path.dirname(root), 'elsewhere');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(root, ROOT_LEASE_FILE));
    expect(acquireRootLease(root)).toEqual({ kind: 'failed', code: 'unsafe_path' });
    fs.unlinkSync(path.join(root, ROOT_LEASE_FILE));
    fs.writeFileSync(path.join(root, ROOT_LEASE_FILE), '', { mode: 0o644 });
    fs.chmodSync(path.join(root, ROOT_LEASE_FILE), 0o644);
    expect(acquireRootLease(root)).toEqual({ kind: 'failed', code: 'unsafe_path' });
  });
});
