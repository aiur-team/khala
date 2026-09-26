// The build under test (#409): an exact npm pin, or a local `npm pack` tarball
// pinned by sha256 and the clean commit it was packed from. A tarball whose bytes
// or provenance do not match the profile refuses the run before any process
// starts, and nothing ever falls back to a live-built tree.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVENANCE_SUFFIX, packageStager } from '../../../scripts/acceptance/adapters/package';
import { checkCommand } from '../../../scripts/acceptance/guard';
import { decodeProfile } from '../../../scripts/acceptance/profile';
import { runAcceptance } from '../../../scripts/acceptance/runner';
import type { KhalaPackage, PackagePort } from '../../../scripts/acceptance/types';
import { RUN_ID, createWorld, offlineProfile, profileInput } from './fakes';

const COMMIT = 'a'.repeat(40);
const BYTES = 'packed @aiur/khala tarball';
const SHA256 = createHash('sha256').update(BYTES).digest('hex');

let directory: string;
let tarball: string;
let root: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-package-'));
  tarball = path.join(directory, 'aiur-khala-0.1.0.tgz');
  root = path.join(directory, 'staging');
  fs.writeFileSync(tarball, BYTES);
  writeProvenance({});
});

afterEach(() => {
  fs.chmodSync(directory, 0o700);
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeProvenance(overrides: Record<string, unknown>): void {
  fs.writeFileSync(`${tarball}${PROVENANCE_SUFFIX}`, JSON.stringify({ v: 1, package: '@aiur/khala', commit: COMMIT, sha256: SHA256, clean: true, ...overrides }));
}

function tarballPackage(overrides: Partial<Record<'tarball' | 'sha256' | 'commit', string>> = {}): Record<string, string> {
  return { tarball, sha256: SHA256, commit: COMMIT, ...overrides };
}

function spec(value: Record<string, string>): KhalaPackage {
  return decodeProfile(profileInput({ khalaPackage: value })).khalaPackage;
}

function staged(): string[] {
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

describe('acceptance profile: khalaPackage', () => {
  it('keeps the exact npm pin form', () => {
    expect(offlineProfile().khalaPackage).toEqual({ kind: 'npm', spec: '@aiur/khala@0.4.0' });
  });

  it('accepts a tarball pinned by sha256 and commit', () => {
    expect(spec(tarballPackage())).toEqual({ kind: 'tarball', path: tarball, sha256: SHA256, commit: COMMIT });
  });

  it.each([
    ['a relative path', { tarball: 'aiur-khala-0.1.0.tgz' }, /tarball/],
    ['a workspace directory', { tarball: '/repo/packages/agent-cli' }, /tarball/],
    ['an unnormalized path', { tarball: '/repo/../tmp/aiur-khala-0.1.0.tgz' }, /tarball/],
    ['an uppercase or short digest', { sha256: SHA256.toUpperCase() }, /sha256/],
    ['an abbreviated commit', { commit: 'abc1234' }, /commit/],
  ])('refuses %s', (_name, overrides, error) => {
    expect(() => spec(tarballPackage(overrides))).toThrow(error);
  });

  it('refuses a tarball with no digest, and any unknown key', () => {
    expect(() => decodeProfile(profileInput({ khalaPackage: { tarball, commit: COMMIT } }))).toThrow(/keys must be exactly/);
    expect(() => decodeProfile(profileInput({ khalaPackage: { ...tarballPackage(), source: '/repo' } }))).toThrow(/keys must be exactly/);
  });
});

describe('package stager', () => {
  it('stages a matching tarball as a private read-only copy and records its measured digest', async () => {
    const result = await packageStager(root).stage(spec(tarballPackage()));
    expect(result.record).toEqual({ kind: 'tarball', source: tarball, sha256: SHA256, commit: COMMIT });
    expect(path.dirname(path.dirname(result.spec))).toBe(root);
    expect(fs.readFileSync(result.spec, 'utf8')).toBe(BYTES);
    expect(fs.statSync(result.spec).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.dirname(result.spec)).mode & 0o777).toBe(0o700);
    // The copy is what runs: changing the source afterwards cannot change it.
    fs.writeFileSync(tarball, 'swapped');
    expect(fs.readFileSync(result.spec, 'utf8')).toBe(BYTES);
    await result.release();
    expect(staged()).toEqual([]);
  });

  it('refuses a tarball whose digest does not match the profile, and leaves no copy', async () => {
    fs.writeFileSync(tarball, `${BYTES} with a different build`);
    await expect(packageStager(root).stage(spec(tarballPackage()))).rejects.toThrow(`does not match the profile's ${SHA256}`);
    expect(staged()).toEqual([]);
  });

  it('refuses a directory, a missing file, and a tarball without clean-tree provenance', async () => {
    const stager = packageStager(root);
    await expect(stager.stage({ kind: 'tarball', path: directory, sha256: SHA256, commit: COMMIT })).rejects.toThrow(/never runs a live-built tree/);
    await expect(stager.stage(spec(tarballPackage({ tarball: path.join(directory, 'missing.tgz') })))).rejects.toThrow(/not a file/);
    fs.rmSync(`${tarball}${PROVENANCE_SUFFIX}`);
    await expect(stager.stage(spec(tarballPackage()))).rejects.toThrow(/acceptance:pack/);
    writeProvenance({ clean: false });
    await expect(stager.stage(spec(tarballPackage()))).rejects.toThrow(/clean-tree pack/);
    expect(staged()).toEqual([]);
  });

  it('refuses a profile whose commit or digest differs from the pack record', async () => {
    const stager = packageStager(root);
    await expect(stager.stage(spec(tarballPackage({ commit: 'b'.repeat(40) })))).rejects.toThrow(/provenance .* does not match/);
    writeProvenance({ sha256: 'c'.repeat(64) });
    await expect(stager.stage(spec(tarballPackage()))).rejects.toThrow(/provenance .* does not match/);
  });

  it('passes an npm pin through unchanged', async () => {
    const result = await packageStager(root).stage({ kind: 'npm', spec: '@aiur/khala@0.4.0' });
    expect(result.spec).toBe('@aiur/khala@0.4.0');
    expect(result.record).toEqual({ kind: 'npm', spec: '@aiur/khala@0.4.0' });
    expect(staged()).toEqual([]);
  });
});

describe('live acceptance runner: build under test', () => {
  const tarballProfile = () => offlineProfile({ khalaPackage: tarballPackage() });

  it('runs status and the launcher from the staged copy, records the digest, and removes the copy', async () => {
    const world = createWorld({}, tarballProfile(), packageStager(root));
    const report = await runAcceptance(world.deps, { profile: world.profile, runId: RUN_ID, resume: null });
    expect(report.khalaPackage).toEqual({ kind: 'tarball', source: tarball, sha256: SHA256, commit: COMMIT });
    const [status, internal] = world.ran;
    expect(status).toMatch(new RegExp(`^status ${root}/package-[^/]+/aiur-khala\\.tgz$`));
    expect(internal).toBe(status!.replace('status', 'internal'));
    expect(world.ran).toHaveLength(2);
    expect(staged()).toEqual([]);
  });

  it('refuses a mismatched tarball before any process starts or any ticket exists', async () => {
    fs.writeFileSync(tarball, 'a live-built tree packed later');
    const world = createWorld({}, tarballProfile(), packageStager(root));
    const report = await runAcceptance(world.deps, { profile: world.profile, runId: RUN_ID, resume: null });
    expect(report.verdict).toBe('refused');
    expect(report.khalaPackage).toBeNull();
    expect(report.errors.join('\n')).toMatch(/tarball sha256 [0-9a-f]{64} does not match/);
    expect(world.ran).toEqual([]);
    expect(world.launcherStarts).toBe(0);
    expect(world.issues.size).toBe(0);
    expect(world.lockReleased()).toBe(true);
  });

  it('never substitutes another build when staging fails', async () => {
    const failing: PackagePort = { async stage() { throw new Error('no build'); } };
    const world = createWorld({}, tarballProfile(), failing);
    const report = await runAcceptance(world.deps, { profile: world.profile, runId: RUN_ID, resume: null });
    expect(report.verdict).toBe('refused');
    expect(world.ran).toEqual([]);
  });

  it('records the npm pin it ran', async () => {
    const world = createWorld();
    const report = await runAcceptance(world.deps, { profile: world.profile, runId: RUN_ID, resume: null });
    expect(report.khalaPackage).toEqual({ kind: 'npm', spec: '@aiur/khala@0.4.0' });
    expect(world.ran).toEqual(['status @aiur/khala@0.4.0', 'internal @aiur/khala@0.4.0']);
  });
});

describe('runner command guard: package specs', () => {
  const copy = '/state/khala-acceptance/packages/package-x1/aiur-khala.tgz';

  it('allows exactly the staged tarball copy', () => {
    expect(checkCommand(['npx', '--yes', copy, 'status'], copy)).toEqual({ ok: true });
    expect(checkCommand(['npx', '--yes', copy, 'internal'], copy)).toEqual({ ok: true });
    expect(checkCommand(['npx', '--yes', '/elsewhere/aiur-khala.tgz', 'status'], copy).ok).toBe(false);
  });

  it.each([
    ['packages/agent-cli'],
    ['/repo/packages/agent-cli'],
    ['./aiur-khala.tgz'],
    ['file:/repo/packages/agent-cli'],
    ['@aiur/khala@latest'],
  ])('never runs a live-built tree or loose spec %s', spec => {
    expect(checkCommand(['npx', '--yes', spec, 'status'], spec)).toEqual({
      ok: false, reason: 'npx runs only an exact npm pin or a digest-checked tarball, never a live-built tree',
    });
  });

  it('allows no npx at all without a staged spec, and still allows gh', () => {
    expect(checkCommand(['npx', '--yes', '@aiur/khala@0.4.0', 'status'], null).ok).toBe(false);
    expect(checkCommand(['gh', 'api', 'repos/aiur-team/khala'], null)).toEqual({ ok: true });
  });
});
