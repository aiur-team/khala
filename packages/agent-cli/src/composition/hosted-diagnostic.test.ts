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

it('persists fixed Matrix writer stages without owner details', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'hosted_open', stage: 'matrix_writer_active',
    result: 'unavailable', privatePid: 123, privatePath: '/secret/profile' } as never);
  recordHostedDiagnostic(root, { component: 'hosted_open', stage: 'matrix_writer_recovered',
    result: 'recovered', privateSession: 'secret-session' } as never);
  const file = path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`);
  expect(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { component: 'hosted_open', stage: 'matrix_writer_active', result: 'unavailable' },
    { component: 'hosted_open', stage: 'matrix_writer_recovered', result: 'recovered' },
  ]);
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

it('persists only fixed subscription fields and bounded HTTP status', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'subscription', stage: 'mailbox_http',
    result: 'unavailable', httpStatus: 503, privateUrl: 'must-not-appear',
  } as never);
  const file = path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`);
  const written = fs.readFileSync(file, 'utf8');
  expect(written).not.toContain('must-not-appear');
  expect(JSON.parse(written)).toEqual({ component: 'subscription', stage: 'mailbox_http',
    result: 'unavailable', httpStatus: 503 });
});

it('persists only a bounded mailbox pending count', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'subscription', stage: 'mailbox_poll_entries',
    result: 'ok', httpStatus: 200, pendingCount: 2, privateBody: 'must-not-appear',
  } as never);
  const written = fs.readFileSync(path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`), 'utf8');
  expect(written).not.toContain('must-not-appear');
  expect(JSON.parse(written)).toEqual({ component: 'subscription', stage: 'mailbox_poll_entries',
    result: 'ok', httpStatus: 200, pendingCount: 2 });
});

it('persists fixed owner-device attestation stages without attached details', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'subscription', stage: 'owner_device_attestation_register_response',
    result: 'unavailable', privateToken: 'must-not-appear',
  } as never);
  const written = fs.readFileSync(path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`), 'utf8').trim();
  expect(JSON.parse(written)).toEqual({ component: 'subscription',
    stage: 'owner_device_attestation_register_response', result: 'unavailable' });
});

it('persists only allowlisted owner trust failure stages across the hosted wire', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'subscription', stage: 'owner_device_trust_peer_device_key_missing',
    result: 'unavailable', localErrorName: 'secret-owner-device', message: 'secret-token',
  } as never);
  recordHostedDiagnostic(root, { component: 'subscription', stage: 'owner_device_trust_peer_secret-owner-device',
    result: 'unavailable', message: 'secret-token',
  } as never);
  const written = fs.readFileSync(path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`), 'utf8');
  expect(written).not.toContain('secret');
  expect(written.trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { component: 'subscription', stage: 'owner_device_trust_peer_device_key_missing', result: 'unavailable' },
    { component: 'subscription', stage: 'guard_exception', result: 'unavailable' },
  ]);
});

it('persists a fixed Matrix read stage without event or key details', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-diagnostic-'));
  recordHostedDiagnostic(root, { component: 'subscription', stage: 'matrix_read_members',
    result: 'unavailable', privateEvent: 'must-not-appear',
  } as never);
  const written = fs.readFileSync(path.join(root, 'hosted', `diagnostics-${process.pid}.jsonl`), 'utf8').trim();
  expect(JSON.parse(written)).toEqual({ component: 'subscription',
    stage: 'matrix_read_members', result: 'unavailable' });
});
