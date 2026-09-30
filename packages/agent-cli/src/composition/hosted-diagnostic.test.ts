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
