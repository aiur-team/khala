import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { recordHostedDiagnostic } from './hosted-diagnostic.js';

let root: string | undefined;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

it('retains only fixed local stages for an MCP process whose stderr is hidden', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'activation', stage: 'activation_result', result: 'blocked' });
  const file = path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    component: 'activation', stage: 'activation_result', result: 'blocked',
  });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
});

it('persists a hosted open storage code without error text or identifiers', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'hosted_open', stage: 'state_storage',
    result: 'unavailable', errorCode: 'locked' });
  const file = path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    component: 'hosted_open', stage: 'state_storage', result: 'unavailable', errorCode: 'locked',
  });
});

it('persists only fixed native readiness fields and boolean prerequisites', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'native_ready', stage: 'connector_unready',
    result: 'unavailable', phase: 'degraded', errorCode: 'subscription_offline',
    prerequisites: { storage: true, device: true, bootstrap: true, subscription: false,
      controls: false, harness: false, dispatch: false, review: false, recovery: false },
    privateIdentifier: 'must-not-appear',
  } as never);
  const file = path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`);
  const written = fs.readFileSync(file, 'utf8');
  expect(written).not.toContain('must-not-appear');
  expect(JSON.parse(written)).toEqual({ component: 'native_ready', stage: 'connector_unready',
    result: 'unavailable', phase: 'degraded', errorCode: 'subscription_offline',
    prerequisites: { storage: true, device: true, bootstrap: true, subscription: false,
      controls: false, harness: false, dispatch: false, review: false, recovery: false } });
});
