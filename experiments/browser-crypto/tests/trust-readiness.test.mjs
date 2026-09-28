import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trustExactDeviceFingerprint, waitForExactDeviceFingerprint } from '../src/trust-readiness.ts';

test('a missing exact device key can arrive later', async () => {
  const observed = [null, null, 'expected'];
  let reads = 0;
  let pauses = 0;
  await waitForExactDeviceFingerprint(async () => { reads += 1; return observed.shift() ?? null; }, 'expected', {
    attempts: 3, intervalMs: 0, pause: async () => { pauses += 1; },
  });
  assert.equal(reads, 3);
  assert.equal(pauses, 2);
});

test('a different key fails immediately without retrying or trusting it', async () => {
  let reads = 0;
  let pauses = 0;
  await assert.rejects(waitForExactDeviceFingerprint(async () => { reads += 1; return 'different'; }, 'expected', {
    attempts: 30, intervalMs: 0, pause: async () => { pauses += 1; },
  }), /out-of-band fingerprint mismatch/u);
  assert.equal(reads, 1);
  assert.equal(pauses, 0);
});

test('an absent exact device stays unavailable after the bound wait', async () => {
  let reads = 0;
  await assert.rejects(waitForExactDeviceFingerprint(async () => { reads += 1; return null; }, 'expected', {
    attempts: 3, intervalMs: 0, pause: async () => undefined,
  }), /out-of-band fingerprint missing/u);
  assert.equal(reads, 3);
});

test('verification refuses a changed key after the initial exact observation', async () => {
  const observed = ['expected', 'different'];
  let verifications = 0;
  await assert.rejects(trustExactDeviceFingerprint(async () => observed.shift() ?? null,
    async () => { verifications += 1; }, 'expected'), /out-of-band fingerprint mismatch/u);
  assert.equal(verifications, 1);
});

test('verification never starts when a different key is already present', async () => {
  let verifications = 0;
  await assert.rejects(trustExactDeviceFingerprint(async () => 'different',
    async () => { verifications += 1; }, 'expected'), /out-of-band fingerprint mismatch/u);
  assert.equal(verifications, 0);
});
