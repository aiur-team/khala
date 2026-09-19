import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type DeliveryLimits, type ReleasedJob, type SessionBinding, decodeApprovalCommand, decodeDeliveryLimits,
  decodeDeliveryReceipt, decodeSessionBinding, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import exact from '../../../contracts/fixtures/delivery/exact-release.json';
import views from '../../../contracts/fixtures/delivery/views.json';
import {
  CLAUDE_TESTED_VERSION, type ClaudeNativeProbe, type ClaudeSessionState, claudeCapabilities, createClaudeHarness,
} from './index';

const unwrap = <T>(decoded: { ok: true; value: T } | { ok: false; field: string }): T => {
  if (!decoded.ok) throw new Error(`fixture failed at ${decoded.field}`);
  return decoded.value;
};

const limits = unwrap(decodeDeliveryLimits(exact.limits));
const text = 'released: please confirm release-nonce-7';
const payload = new TextEncoder().encode(text);
const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
const clock = () => new Date('2026-09-18T10:00:00.000Z');

function claudeBinding(generation = 0): SessionBinding {
  return unwrap(decodeSessionBinding({ ...exact.binding, harness: 'claude', sessionId: 'session-b', generation }));
}

function releasedJob(overrides: Partial<{ releaseId: string; payloadDigest: string }> = {}): ReleasedJob {
  const approval = unwrap(decodeApprovalCommand(exact.approvalCommand, limits));
  const released = releaseFromApproval({
    approval,
    items: approval.selection,
    binding: claudeBinding(),
    policyVersion: approval.expectedPolicyVersion,
    release: { ...exact.release, payloadDigest: digest, ...overrides } as never,
  });
  if (!released.ok) throw new Error(`release failed: ${released.code}`);
  return released.value;
}

function fakeProbe(session: ClaudeSessionState = 'present', version: string | null = CLAUDE_TESTED_VERSION) {
  const calls: string[] = [];
  const probe: ClaudeNativeProbe = {
    async installedVersion() {
      calls.push('installedVersion');
      return version;
    },
    async session(sessionId) {
      calls.push(`session:${sessionId}`);
      return session;
    },
  };
  return { probe, calls };
}

const harness = (probe: ClaudeNativeProbe, withLimits: DeliveryLimits = limits) =>
  createClaudeHarness({ probe, clock, limits: withLimits });

describe('claudeCapabilities', () => {
  it('reports the tested version exactly as the contract fixture records it', () => {
    const row = views.valid.find(view => view.input.adapterVersion === 'no-setup-route')!.input as { limits: unknown };
    const fixtureLimits = unwrap(decodeDeliveryLimits(row.limits));
    expect(claudeCapabilities(CLAUDE_TESTED_VERSION, fixtureLimits)).toEqual(row);
  });

  it('never promotes an untested version by semver', () => {
    for (const version of ['2.1.277', '3.0.0', '2.1.275']) {
      expect(claudeCapabilities(version, limits)).toMatchObject({
        version,
        support: 'unsupported',
        existingSession: 'unknown',
        immediateNotification: 'unknown',
        busy: 'unknown',
        receiptEvidence: [],
        reconcileByReleaseId: 'unknown',
        evidenceRef: null,
      });
    }
  });

  it('reports an absent or malformed version as unknown without echoing it', () => {
    expect(claudeCapabilities(null, limits).version).toBe('unknown');
    expect(claudeCapabilities('2.1.276\nsecret', limits).version).toBe('unknown');
  });
});

describe('createClaudeHarness', () => {
  it('inspects the bound session read-only and pins its capabilities', async () => {
    const { probe, calls } = fakeProbe();
    const report = await harness(probe).inspect(claudeBinding());
    expect(report.support).toBe('unsupported');
    expect(report.existingSession).toBe('unsupported');
    expect(calls.sort()).toEqual(['installedVersion', 'session:session-b']);
  });

  it('refuses a binding for another harness before probing', async () => {
    const { probe, calls } = fakeProbe();
    await expect(harness(probe).inspect({ ...claudeBinding(), harness: 'codex' })).rejects.toThrow('another harness');
    expect(calls).toEqual([]);
  });

  it('refuses a verified, matching release because no route is proven (AE2)', async () => {
    const { probe, calls } = fakeProbe();
    const adapter = harness(probe);
    await adapter.inspect(claudeBinding());
    calls.length = 0;
    const receipt = await adapter.submit({ job: releasedJob(), payload });
    expect(receipt).toMatchObject({
      kind: 'failed', errorCode: 'harness_unavailable', source: 'connector', evidenceRef: null,
      releaseId: 'release-1', bindingId: 'bind-b-1', generation: 0, observedAt: '2026-09-18T10:00:00.000Z',
    });
    expect(unwrap(decodeDeliveryReceipt(receipt))).toEqual(receipt);
    // Submission touches no native surface at all.
    expect(calls).toEqual([]);
  });

  it.each([
    ['absent', 'session_unavailable'],
    ['not_owned', 'session_unavailable'],
  ] as const)('reports a %s session as %s', async (session, code) => {
    const adapter = harness(fakeProbe(session).probe);
    await adapter.inspect(claudeBinding());
    expect((await adapter.submit({ job: releasedJob(), payload })).errorCode).toBe(code);
  });

  it('refuses a release for a binding it never inspected', async () => {
    const receipt = await harness(fakeProbe().probe).submit({ job: releasedJob(), payload });
    expect(receipt.errorCode).toBe('session_unavailable');
  });

  it('refuses a release made for an earlier binding generation', async () => {
    const adapter = harness(fakeProbe().probe);
    await adapter.inspect(claudeBinding(1));
    expect((await adapter.submit({ job: releasedJob(), payload })).errorCode).toBe('stale_binding');
  });

  it('refuses bytes that do not match the released digest', async () => {
    const adapter = harness(fakeProbe().probe);
    await adapter.inspect(claudeBinding());
    const pending = new TextEncoder().encode(`${text} + pending: unreviewed text`);
    expect((await adapter.submit({ job: releasedJob(), payload: pending })).errorCode).toBe('payload_digest_mismatch');
  });

  it('refuses a payload over the configured byte limit', async () => {
    const small = unwrap(decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 8 }));
    const adapter = harness(fakeProbe().probe, small);
    await adapter.inspect(claudeBinding());
    expect((await adapter.submit({ job: releasedJob(), payload })).errorCode).toBe('limit_exceeded');
  });

  it('keeps receipts content-free and their IDs stable across restarts', async () => {
    const first = harness(fakeProbe().probe);
    const second = harness(fakeProbe().probe);
    await first.inspect(claudeBinding());
    await second.inspect(claudeBinding());
    const a = await first.submit({ job: releasedJob(), payload });
    const b = await second.submit({ job: releasedJob(), payload });
    expect(a.receiptId).toBe(b.receiptId);
    expect(JSON.stringify(a)).not.toContain('release-nonce-7');

    const otherRelease = await first.submit({ job: releasedJob({ releaseId: 'release-2' }), payload });
    const otherOutcome = await first.submit({ job: releasedJob(), payload: new Uint8Array([1]) });
    expect(new Set([a.receiptId, otherRelease.receiptId, otherOutcome.receiptId]).size).toBe(3);
  });

  it('has no reconciliation evidence and notify never reaches the harness', async () => {
    const { probe, calls } = fakeProbe();
    const adapter = harness(probe);
    await adapter.notify(claudeBinding(), { v: 1, releaseId: releasedJob().releaseId });
    expect(await adapter.reconcile(releasedJob())).toBeNull();
    expect(calls).toEqual([]);
  });

  it('refuses everything after close', async () => {
    const adapter = harness(fakeProbe().probe);
    await adapter.inspect(claudeBinding());
    await adapter.close();
    expect((await adapter.submit({ job: releasedJob(), payload })).errorCode).toBe('harness_unavailable');
    await expect(adapter.inspect(claudeBinding())).rejects.toThrow('closed');
  });
});
