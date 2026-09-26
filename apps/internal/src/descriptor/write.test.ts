import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseInternalDescriptor } from '@khala/contracts/internal/descriptor';
import {
  LAUNCH_RECORD_FILE, PrivateFileError, activeDescriptorPath, encodeLaunchRecord, ensurePrivateDirectory,
  removeActiveDescriptor, writeActiveDescriptor, writeLaunchRecord, writePrivateFile,
} from './write';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function makeRoot(): string {
  const base = fs.mkdtempSync(path.join('/tmp', 'khala-descriptor-'));
  roots.push(base);
  fs.chmodSync(base, 0o700);
  return base;
}

const capability = (fill: string) => `${fill.repeat(42)}A`;
const descriptor = { v: 1 as const, channelId: 'ch_1', origin: 'http://127.0.0.1:4870', transportCapability: capability('t') };

describe('private descriptor files', () => {
  it('publishes the active descriptor atomically as a 0600 file in a 0700 root', () => {
    const root = path.join(makeRoot(), 'internal');
    writeActiveDescriptor(root, descriptor);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(activeDescriptorPath(root)).mode & 0o777).toBe(0o600);
    expect(parseInternalDescriptor(fs.readFileSync(activeDescriptorPath(root), 'utf8'))).toEqual({ ok: true, value: descriptor });
    expect(fs.readdirSync(root)).toEqual(['active.json']);

    const rotated = { ...descriptor, origin: 'http://127.0.0.1:4871', transportCapability: capability('u') };
    writeActiveDescriptor(root, rotated);
    expect(parseInternalDescriptor(fs.readFileSync(activeDescriptorPath(root), 'utf8'))).toEqual({ ok: true, value: rotated });
    expect(removeActiveDescriptor(root)).toBe(true);
    expect(removeActiveDescriptor(root)).toBe(false);
  });

  it('leaves the previous bytes in place when a write is interrupted before publication', () => {
    const root = makeRoot();
    writeActiveDescriptor(root, descriptor);
    const before = fs.readFileSync(activeDescriptorPath(root));
    expect(() => writeActiveDescriptor(root, { ...descriptor, transportCapability: capability('x') }, () => { throw new Error('crash'); }))
      .toThrow(PrivateFileError);
    expect(fs.readFileSync(activeDescriptorPath(root)).equals(before)).toBe(true);
    expect(fs.readdirSync(root)).toEqual(['active.json']);
  });

  it('refuses invalid descriptors before any file is touched', () => {
    const root = makeRoot();
    expect(() => writeActiveDescriptor(root, { ...descriptor, origin: 'http://localhost:1' })).toThrow(TypeError);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses symlinked, shared, or foreign targets instead of following them', () => {
    const base = makeRoot();
    const outside = path.join(base, 'outside.json');
    fs.writeFileSync(outside, 'keep');
    const root = path.join(base, 'root');
    fs.mkdirSync(root, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(root, 'active.json'));
    expect(() => writeActiveDescriptor(root, descriptor)).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');

    const linkedRoot = path.join(base, 'linked');
    fs.symlinkSync(root, linkedRoot);
    expect(() => ensurePrivateDirectory(linkedRoot)).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared, { mode: 0o755 });
    fs.chmodSync(shared, 0o755);
    expect(() => writePrivateFile(shared, 'x', 'y')).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
    expect(() => ensurePrivateDirectory('relative/root')).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
  });

  it('writes a strict launch record and never echoes its secret in errors', () => {
    const channel = makeRoot();
    const record = { v: 1 as const, channelId: 'ch_1', origin: 'http://127.0.0.1:4870', bootstrapCredential: capability('b'), expiresAt: 1_000 };
    writeLaunchRecord(channel, record);
    expect(fs.statSync(path.join(channel, LAUNCH_RECORD_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(channel, LAUNCH_RECORD_FILE), 'utf8'))).toEqual(record);
    expect(() => encodeLaunchRecord({ ...record, bootstrapCredential: 'short-secret' })).toThrow(/^launch record: invalid$/);
  });
});
