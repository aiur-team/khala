#!/usr/bin/env node
// Isolated live conformance check for the Netlify Blobs control-store adapter
// (apps/control/src/runtime/control-store.ts). Exercises a handful of CAS
// scenarios against a real, disposable Blobs namespace. Never runs against
// production: refuses unless --environment preview is passed explicitly, and
// only ever touches keys under a `khala-live-check/` prefix it creates and
// deletes itself. Not run automatically by any build or test script — an
// operator runs it manually against a provisioned preview site.
//
//   pnpm exec tsx infra/netlify/control-store-live-check.ts --environment preview
//
// Requires NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN for the target preview site.
// Never prints their values; only sanitized pass/fail evidence.

import { randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { createControlStore } from '../../apps/control/src/runtime/control-store.ts';

export class LiveCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCheckError';
  }
}

function parseArguments(argv: string[]): { environment: string } {
  let environment: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--environment') environment = argv[++index];
  }
  if (!environment) throw new LiveCheckError('missing --environment argument');
  if (environment !== 'preview') throw new LiveCheckError('refuses any target other than --environment preview');
  return { environment };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new LiveCheckError(`missing required environment variable ${name}`);
  return value;
}

type CheckResult = Readonly<{ name: string; pass: boolean; detail?: string }>;

async function run(argv = process.argv.slice(2), env = process.env): Promise<readonly CheckResult[]> {
  parseArguments(argv);
  const siteID = requireEnv('NETLIFY_SITE_ID');
  const token = requireEnv('NETLIFY_AUTH_TOKEN');
  const namespace = env.CONTROL_STATE_NAMESPACE ?? `khala-live-check-${Date.now()}`;
  if (!namespace.startsWith('khala-live-check')) {
    throw new LiveCheckError('CONTROL_STATE_NAMESPACE must be a disposable khala-live-check-* namespace for this script');
  }

  const records = getStore({ name: `${namespace}-records`, siteID, token, consistency: 'strong' });
  const operations = getStore({ name: `${namespace}-operations`, siteID, token, consistency: 'strong' });
  const store = createControlStore({ records, operations, clock: () => Date.now() });

  const prefix = `khala-live-check/${randomUUID()}`;
  const results: CheckResult[] = [];
  const recordKeys: string[] = [];
  const operationKeys: string[] = [];
  const check = async (name: string, run: () => Promise<boolean>) => {
    try {
      results.push({ name, pass: await run() });
    } catch (error) {
      results.push({ name, pass: false, detail: error instanceof Error ? error.name : 'unexpected_error' });
    }
  };

  try {
    await check('create-if-absent succeeds once', async () => {
      const key = `${prefix}/owner`;
      recordKeys.push(key);
      operationKeys.push(`${prefix}-a`, `${prefix}-b`);
      const first = await store.compareAndSet({ key, expectedRevision: null, operationId: `${prefix}-a`, next: { value: 'alice', expiresAt: null } });
      const second = await store.compareAndSet({ key, expectedRevision: null, operationId: `${prefix}-b`, next: { value: 'bob', expiresAt: null } });
      return first.kind === 'applied' && second.kind === 'conflict';
    });

    await check('operation ID reuse across keys is rejected without writing the second key', async () => {
      const keyA = `${prefix}/title-a`;
      const keyB = `${prefix}/title-b`;
      const operationId = `${prefix}-reused`;
      recordKeys.push(keyA, keyB);
      operationKeys.push(operationId);
      await store.compareAndSet({ key: keyA, expectedRevision: null, operationId, next: { value: 'first', expiresAt: null } });
      const mismatch = await store.compareAndSet({ key: keyB, expectedRevision: null, operationId, next: { value: 'first', expiresAt: null } });
      const stillAbsent = await store.read(keyB);
      return mismatch.kind === 'operation_mismatch' && stillAbsent.kind === 'absent';
    });

    await check('an expired record allows a fresh create-if-absent', async () => {
      const key = `${prefix}/expiring`;
      recordKeys.push(key);
      operationKeys.push(`${prefix}-exp1`, `${prefix}-exp2`);
      await store.compareAndSet({
        key, expectedRevision: null, operationId: `${prefix}-exp1`,
        next: { value: 'first', expiresAt: new Date(Date.now() - 1000).toISOString() },
      });
      const recreated = await store.compareAndSet({ key, expectedRevision: null, operationId: `${prefix}-exp2`, next: { value: 'second', expiresAt: null } });
      return recreated.kind === 'applied';
    });
  } finally {
    // Best-effort cleanup: this is a disposable namespace, but leaving no
    // trace makes repeated runs cheaper to audit.
    await Promise.all([
      ...recordKeys.map(key => records.delete(key).catch(() => undefined)),
      ...operationKeys.map(key => operations.delete(key).catch(() => undefined)),
    ]);
  }

  return results;
}

if (process.argv[1] && new URL(process.argv[1], 'file:').pathname === new URL(import.meta.url).pathname) {
  run()
    .then(results => {
      for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? ` (${result.detail})` : ''}`);
      process.exitCode = results.some(result => !result.pass) ? 1 : 0;
    })
    .catch(error => {
      console.error(error instanceof LiveCheckError ? `live check refused: ${error.message}` : 'live check failed unexpectedly');
      process.exitCode = 1;
    });
}
