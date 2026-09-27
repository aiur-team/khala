// The build under test. An npm pin passes through unchanged. A local tarball is
// copied into a private directory and hashed there, and it is refused unless the
// copy's sha256 and the pack script's provenance record both match the profile.
// `npx` then runs only that copy, so the file checked is the file installed. There
// is no fallback: a missing, mismatched or directory "tarball" refuses the run.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PackagePort } from '../types';

/** Written next to the tarball by `scripts/acceptance-pack.mjs`. */
export const PROVENANCE_SUFFIX = '.provenance.json';

type Provenance = Readonly<{ commit: string; sha256: string }>;

async function readProvenance(tarball: string): Promise<Provenance> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(`${tarball}${PROVENANCE_SUFFIX}`, 'utf8'));
  } catch {
    throw new Error(`tarball ${tarball} has no readable ${PROVENANCE_SUFFIX}; pack it from a clean tree with pnpm acceptance:pack`);
  }
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  if (record.v !== 1 || record.clean !== true || typeof record.commit !== 'string' || typeof record.sha256 !== 'string') {
    throw new Error(`tarball ${tarball} provenance does not record a clean-tree pack`);
  }
  return { commit: record.commit, sha256: record.sha256 };
}

/** Stages tarball copies under `root`, one private directory per run. */
export function packageStager(root: string): PackagePort {
  return {
    async stage(khalaPackage) {
      if (khalaPackage.kind === 'npm') {
        return { spec: khalaPackage.spec, record: { kind: 'npm', spec: khalaPackage.spec }, release: async () => {} };
      }
      const source = await fs.stat(khalaPackage.path).catch(() => null);
      if (!source?.isFile()) throw new Error(`tarball ${khalaPackage.path} is not a file; the runner never runs a live-built tree`);
      const provenance = await readProvenance(khalaPackage.path);
      if (provenance.commit !== khalaPackage.commit || provenance.sha256 !== khalaPackage.sha256) {
        throw new Error(`tarball provenance (commit ${provenance.commit}, sha256 ${provenance.sha256}) does not match the profile`);
      }
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(path.join(root, 'package-'));
      const release = () => fs.rm(directory, { recursive: true, force: true });
      try {
        const copy = path.join(directory, 'aiur-khala.tgz');
        await fs.copyFile(khalaPackage.path, copy, fs.constants.COPYFILE_EXCL);
        await fs.chmod(copy, 0o400);
        const sha256 = createHash('sha256').update(await fs.readFile(copy)).digest('hex');
        if (sha256 !== khalaPackage.sha256) {
          throw new Error(`tarball sha256 ${sha256} does not match the profile's ${khalaPackage.sha256}`);
        }
        return { spec: copy, record: { kind: 'tarball', source: khalaPackage.path, sha256, commit: khalaPackage.commit }, release };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}
