import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfinedFilesystem, SetupFilesystemError, sha256 } from './filesystem.js';
import { bytes } from './fixtures/setup-home.js';

let root: string;
let outside: string;
let confined: ConfinedFilesystem;

beforeEach(async () => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), 'khala-fs-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
  confined = new ConfinedFilesystem([root]);
});
afterEach(async () => {
  await fsp.rm(path.dirname(root), { recursive: true, force: true });
});

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SetupFilesystemError);
    return (error as SetupFilesystemError).code;
  }
  throw new Error('expected a refusal');
};

describe('confined filesystem', () => {
  it('refuses paths outside, equal to, or lexically escaping the roots', async () => {
    expect(await code(confined.observe(path.join(outside, 'x')))).toBe('unsafe_path');
    expect(await code(confined.observe(root))).toBe('unsafe_path');
    expect(await code(confined.observe(`${root}/a/../../outside/x`))).toBe('unsafe_path');
    expect(await code(confined.observe('relative/x'))).toBe('unsafe_path');
  });

  it('refuses a symbolic link anywhere below the root, final or intermediate', async () => {
    await fsp.writeFile(path.join(outside, 'secret'), 'secret');
    await fsp.symlink(path.join(outside, 'secret'), path.join(root, 'file'));
    await fsp.symlink(outside, path.join(root, 'dir'));
    expect(await code(confined.observe(path.join(root, 'file')))).toBe('unsafe_path');
    expect(await code(confined.observe(path.join(root, 'dir', 'secret')))).toBe('unsafe_path');
    expect(await code(confined.replace(path.join(root, 'dir', 'new'), null, bytes('x'), 0o600))).toBe('unsafe_path');
    expect(await fsp.readdir(outside)).toEqual(['secret']);
  });

  it('replaces atomically only from the expected preimage and preserves concurrent bytes', async () => {
    const target = path.join(root, 'config.json');
    await confined.replace(target, null, bytes('one'), 0o640);
    expect((await confined.observe(target))!.mode).toBe(0o640);
    expect(await code(confined.replace(target, null, bytes('two'), 0o600))).toBe('precondition_failed');
    expect(await code(confined.replace(target, sha256(bytes('stale')), bytes('two'), 0o600))).toBe('precondition_failed');
    await confined.replace(target, sha256(bytes('one')), bytes('two'), 0o600);
    expect(await fsp.readFile(target, 'utf8')).toBe('two');
    expect((await fsp.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('deletes only the expected bytes and verifies exact postimage mode and hash', async () => {
    const target = path.join(root, 'f');
    await fsp.writeFile(target, 'user');
    expect(await code(confined.remove(target, sha256(bytes('other'))))).toBe('precondition_failed');
    expect(await code(confined.verify(target, sha256(bytes('user')), 0o400))).toBe('postimage_mismatch');
    await fsp.chmod(target, 0o400);
    await confined.verify(target, sha256(bytes('user')), 0o400);
    await confined.remove(target, sha256(bytes('user')));
    await confined.verify(target, null, null);
  });

  it('tracks and prunes only the directories it created', async () => {
    const target = path.join(root, 'a', 'b', 'c', 'file');
    await fsp.mkdir(path.join(root, 'a'));
    const created = await confined.missingDirectories(target);
    expect(created).toEqual([path.join(root, 'a', 'b'), path.join(root, 'a', 'b', 'c')]);
    await confined.createDirectories(created);
    await fsp.writeFile(path.join(root, 'a', 'b', 'keep'), 'user');
    await confined.removeEmptyDirectories(created);
    expect(await fsp.readdir(path.join(root, 'a', 'b'))).toEqual(['keep']);
  });
});
