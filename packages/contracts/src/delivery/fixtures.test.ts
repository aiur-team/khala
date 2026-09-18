import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import messagingIntro from '../../fixtures/messaging/exact-intro.json';
import approval from '../../fixtures/delivery/approval.json';
import capabilities from '../../fixtures/delivery/capabilities.json';
import exact from '../../fixtures/delivery/exact-release.json';
import { decodeSessionBinding } from './binding';
import { decodeApprovalCommand, decodePolicySetCommand } from './commands';
import { decodeDeliveryLimits } from './decode';
import { decodeEventRef } from './events';
import * as fixtureSubpath from './fixtures';
import { decodeHarnessCapabilities } from './harness';
import * as delivery from './index';
import { decodeReleasedJob } from './jobs';

describe('literal delivery fixture', () => {
  it('decodes every core value without changing its JSON bytes', () => {
    const limits = decodeDeliveryLimits(exact.limits);
    expect(limits).toEqual({ ok: true, value: exact.limits });
    if (!limits.ok) throw new Error('fixture limits must decode');

    for (const [decoder, input] of [
      [decodeEventRef, exact.eventRef],
      [decodeSessionBinding, exact.binding],
      [(value: unknown) => decodeApprovalCommand(value, limits.value), exact.approvalCommand],
      [decodePolicySetCommand, exact.policySetCommand],
      [(value: unknown) => decodeReleasedJob(value, limits.value), exact.releasedJob],
    ] as const) {
      const decoded = decoder(input);
      expect(decoded).toEqual({ ok: true, value: input });
      if (decoded.ok) expect(JSON.stringify(decoded.value)).toBe(JSON.stringify(input));
    }
  });

  it('pins cross-contract scalar parity without production imports', () => {
    expect(Object.keys(exact.eventRef).sort()).toEqual(Object.keys(messagingIntro.eventRef).sort());
    expect(Object.keys(exact.binding).sort()).toEqual(Object.keys(messagingIntro.binding).sort());
    expect(exact.eventRef.contentDigest).toBe(messagingIntro.encoding.contentDigest);
    expect(exact.eventRef.contentDigest).toBe('sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b');
  });
});

describe('conformance fixture subpath', () => {
  it('exports the exact JSON suites for consumers', () => {
    expect(JSON.parse(readFileSync(fixtureSubpath.deliveryFixtureUrls.exactRelease, 'utf8'))).toEqual(exact);
    expect(JSON.parse(readFileSync(fixtureSubpath.deliveryFixtureUrls.approval, 'utf8'))).toEqual(approval);
    expect(JSON.parse(readFileSync(fixtureSubpath.deliveryFixtureUrls.capabilities, 'utf8'))).toEqual(capabilities);
  });

  it('keeps fixtures out of the production index', () => {
    expect(Object.keys(delivery).filter(name => /fixture|fake/i.test(name))).toEqual([]);
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '[^']*(fixtures|\.test)/);
    for (const file of ['decode.ts', 'ids.ts', 'events.ts', 'binding.ts', 'jobs.ts', 'commands.ts', 'receipts.ts', 'harness.ts']) {
      const implementation = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(implementation).not.toMatch(/messaging/);
    }
  });

  it.each(capabilities.valid)('decodes capability fixture: $name', testCase => {
    expect(decodeHarnessCapabilities(testCase.input)).toEqual({ ok: true, value: testCase.input });
  });
});
