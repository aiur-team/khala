/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate decoded JSON to build invalid inputs */
import { describe, expect, it } from 'vitest';
import { ManifestSchemaError, decodeManifest, encodeManifest, parseManifest, referencedBackupTransactions } from './manifest.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const tx = '0b6f1a52-3c1d-4e8b-9a1e-5d2f7c9e1a00';
const entry = (path: string, overrides: Record<string, unknown> = {}) => ({
  path, harness: 'claude', component: 'mcp_entry', ownership: 'foreign', operationId: 'op1', postimage: digest('b'),
  mode: 0o644, baseline: { hash: digest('a'), backup: `${tx}/0`, mode: 0o644 }, createdDirectories: [], ...overrides,
});
const valid = { v: 1, transaction: tx, planDigest: digest('c'), entries: [entry('/h/b'), entry('/h/a')] };
const clone = <T>(value: T): T => structuredClone(value);
const rejects = (value: unknown) => {
  expect(() => decodeManifest(value)).toThrow(ManifestSchemaError);
};

describe('setup manifest', () => {
  it('round-trips with stable path ordering', () => {
    const decoded = decodeManifest(valid);
    expect(decoded.entries.map(item => item.path)).toEqual(['/h/a', '/h/b']);
    expect(parseManifest(encodeManifest(decoded))).toEqual(decoded);
    expect(referencedBackupTransactions(decoded)).toEqual(new Set([tx]));
  });

  it('flags a newer schema separately from corruption', () => {
    try {
      decodeManifest({ v: 2 });
    } catch (error) {
      expect((error as ManifestSchemaError).unsupportedVersion).toBe(true);
    }
    expect(() => parseManifest(new TextEncoder().encode('{'))).toThrow(ManifestSchemaError);
  });

  it('rejects unknown keys, inconsistent baselines, installer baselines, duplicate or relative paths', () => {
    rejects({ ...valid, extra: true });
    const cases: ((m: any) => void)[] = [
      m => { m.entries[0].contents = 'secret'; },
      m => { m.entries[0].baseline = { hash: digest('a'), backup: null, mode: 0o644 }; },
      m => { m.entries[0].baseline = { hash: null, backup: null, mode: 0o644 }; },
      m => { m.entries[0].baseline.backup = '../escape/0'; },
      m => { m.entries[0].ownership = 'installer'; },
      m => { m.entries[1].path = m.entries[0].path; },
      m => { m.entries[0].path = 'relative'; },
      m => { m.entries[0].createdDirectories = ['/h/../etc']; },
      m => { m.entries[0].mode = 0o10000; },
    ];
    for (const mutate of cases) {
      const manifest = clone(valid);
      mutate(manifest);
      rejects(manifest);
    }
  });
});
