#!/usr/bin/env node

// Delete only the two recorded KHA-134 preview targets. This tool never reads
// provider variables, deployment logs, or rendered secret configuration.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = '9f30bc02-e7b5-45c4-95f4-e50b10034696';
const PRODUCTION_ENVIRONMENT = '6ca01f48-1cc9-40f1-aa84-31e2bdc376dc';
const PRODUCTION_SITE = 'e95155c4-1070-46f8-95eb-4ca86df16030';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export type Target = Readonly<{
  v: 1;
  purpose: 'khala-134-disposable-preview';
  railwayProjectId: string;
  railwayEnvironmentId: string;
  railwayEnvironmentName: string;
  netlifySiteId: string;
  netlifySiteName: string;
  teardownAfter: string;
}>;

export function decodeTarget(value: unknown): Target {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-target');
  const r = value as Record<string, unknown>;
  const keys = ['v', 'purpose', 'railwayProjectId', 'railwayEnvironmentId', 'railwayEnvironmentName',
    'netlifySiteId', 'netlifySiteName', 'teardownAfter'];
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))
    || r.v !== 1 || r.purpose !== 'khala-134-disposable-preview' || r.railwayProjectId !== PROJECT
    || typeof r.railwayEnvironmentId !== 'string' || !UUID.test(r.railwayEnvironmentId)
    || r.railwayEnvironmentId === PRODUCTION_ENVIRONMENT
    || typeof r.railwayEnvironmentName !== 'string' || !/^preview-[a-z0-9-]{4,40}$/.test(r.railwayEnvironmentName)
    || typeof r.netlifySiteId !== 'string' || !UUID.test(r.netlifySiteId) || r.netlifySiteId === PRODUCTION_SITE
    || typeof r.netlifySiteName !== 'string' || !/^khala-134-preview-[a-z0-9-]{4,40}$/.test(r.netlifySiteName)
    || typeof r.teardownAfter !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.teardownAfter)
    || !Number.isFinite(Date.parse(r.teardownAfter))) throw new Error('invalid-target');
  return r as Target;
}

function command(executable: string, args: string[], cwd?: string): string {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${executable}-operation-failed`);
  return result.stdout;
}

function preflight(target: Target, directory: string): void {
  command('railway', ['link', '--project', target.railwayProjectId, '--environment', target.railwayEnvironmentId, '--json'], directory);
  const environments = JSON.parse(command('railway', ['environment', 'list', '--json'], directory)) as { environments?: unknown };
  if (!Array.isArray(environments.environments)) throw new Error('railway-inventory-unavailable');
  const selected = environments.environments.find((item: unknown) => item && typeof item === 'object'
    && (item as Record<string, unknown>).id === target.railwayEnvironmentId) as Record<string, unknown> | undefined;
  if (selected?.name !== target.railwayEnvironmentName) throw new Error('railway-target-mismatch');
  if (!environments.environments.some((item: unknown) => item && typeof item === 'object'
    && (item as Record<string, unknown>).id === PRODUCTION_ENVIRONMENT)) throw new Error('production-environment-not-visible');
  const site = JSON.parse(command('netlify', ['api', 'getSite', '--data', JSON.stringify({ site_id: target.netlifySiteId })])) as Record<string, unknown>;
  if (site.id !== target.netlifySiteId || site.name !== target.netlifySiteName) throw new Error('netlify-target-mismatch');
  const production = JSON.parse(command('netlify', ['api', 'getSite', '--data', JSON.stringify({ site_id: PRODUCTION_SITE })])) as Record<string, unknown>;
  if (production.id !== PRODUCTION_SITE) throw new Error('production-site-not-visible');
}

export function run(target: Target, apply: boolean): void {
  const directory = mkdtempSync(join(tmpdir(), 'khala-134-teardown-'));
  try {
    preflight(target, directory);
    if (!apply) {
      process.stdout.write(`checked preview environment ${target.railwayEnvironmentId} and site ${target.netlifySiteId}; no deletion\n`);
      return;
    }
    if (Date.now() < Date.parse(target.teardownAfter)) throw new Error('teardown-deadline-not-reached');
    if (process.env.KHALA_134_TEARDOWN_APPROVED_TARGET !== `${target.railwayEnvironmentId}:${target.netlifySiteId}`) {
      throw new Error('teardown-target-approval-missing');
    }
    command('netlify', ['sites:delete', '--force', target.netlifySiteId]);
    command('railway', ['environment', 'delete', target.railwayEnvironmentId, '--yes'], directory);
    command('railway', ['link', '--project', target.railwayProjectId, '--environment', PRODUCTION_ENVIRONMENT, '--json'], directory);
    const after = JSON.parse(command('railway', ['environment', 'list', '--json'], directory)) as { environments?: unknown };
    if (!Array.isArray(after.environments)
      || after.environments.some((item: unknown) => item && typeof item === 'object'
        && (item as Record<string, unknown>).id === target.railwayEnvironmentId)
      || !after.environments.some((item: unknown) => item && typeof item === 'object'
        && (item as Record<string, unknown>).id === PRODUCTION_ENVIRONMENT)) throw new Error('railway-deletion-unverified');
    const production = JSON.parse(command('netlify', ['api', 'getSite', '--data', JSON.stringify({ site_id: PRODUCTION_SITE })])) as Record<string, unknown>;
    if (production.id !== PRODUCTION_SITE) throw new Error('production-site-not-visible');
    process.stdout.write(`deleted preview environment ${target.railwayEnvironmentId} and site ${target.netlifySiteId}; production targets still visible\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [flag, file, action] = process.argv.slice(2);
    if (flag !== '--manifest' || !file || (action !== '--check' && action !== '--apply') || process.argv.length !== 5) {
      throw new Error('usage: node infra/preview/teardown.ts --manifest <private-target.json> --check|--apply');
    }
    run(decodeTarget(JSON.parse(readFileSync(file, 'utf8'))), action === '--apply');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'teardown-failed'}\n`);
    process.exitCode = 1;
  }
}
