import { describe, expect, it } from 'vitest';
import { decisionFingerprint, evaluateApproval, type Evaluation } from './index';
import { binding, command, record, scenario, text } from './fixtures/sample';

const decision = (result: Evaluation) => {
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result.decision;
};

describe('release decision handoff', () => {
  it('yields the same decision for the same command and snapshot', async () => {
    const { input } = await scenario();
    const first = decision(await evaluateApproval(input));
    const again = decision(await evaluateApproval({ ...input, pending: [...input.pending].reverse() }));
    expect(again).toEqual(first);
    expect(again.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(again.job.payloadDigest).toBe(first.job.payloadDigest);
  });

  it('keeps the fingerprint independent of releaser-chosen identifiers', async () => {
    const { input } = await scenario();
    const first = decision(await evaluateApproval(input));
    const other = decision(await evaluateApproval({
      ...input,
      release: { ...input.release, releaseId: 'release-2' as never, payloadRef: 'ledger-release-2' },
    }));
    expect(other.fingerprint).toBe(first.fingerprint);
    expect(other.job.payloadDigest).not.toBe(first.job.payloadDigest);
  });

  it('gives the same command ID with changed bytes a conflicting fingerprint', async () => {
    const { input, a } = await scenario();
    const first = decision(await evaluateApproval(input));
    const changed = await record('event-b', 'Second point: turn the flag ON.');
    const conflicting = decision(await evaluateApproval({
      ...input,
      command: command([a.ref, changed.ref]),
      pending: [a, changed],
    }));
    expect(conflicting.commandId).toBe(first.commandId);
    expect(conflicting.fingerprint).not.toBe(first.fingerprint);
  });

  it('binds the fingerprint to the expected generation and policy the owner reviewed', async () => {
    const { input } = await scenario();
    const first = decision(await evaluateApproval(input));
    const rebound = decision(await evaluateApproval({
      ...input,
      binding: binding(1),
      command: { ...input.command, expectedBindingGeneration: 1 },
    }));
    const repolicied = decision(await evaluateApproval({
      ...input,
      policyVersion: 4,
      command: { ...input.command, expectedPolicyVersion: 4 },
    }));
    expect(new Set([first.fingerprint, rebound.fingerprint, repolicied.fingerprint]).size).toBe(3);
  });

  it('conflicts when a retry reuses the command ID with a different issuedAt', async () => {
    const { input } = await scenario();
    const first = await decisionFingerprint(input.command);
    const redated = await decisionFingerprint({ ...input.command, issuedAt: '2026-09-18T00:00:01Z' });
    expect(redated.ok && first.ok && redated.digest !== first.digest).toBe(true);
  });

  it('conflicts when a retry reuses the command ID with a reordered selection', async () => {
    const { input, a, b } = await scenario();
    const first = await decisionFingerprint(command([a.ref, b.ref]));
    const reordered = await decisionFingerprint(command([b.ref, a.ref]));
    expect(reordered.ok && first.ok && reordered.digest !== first.digest).toBe(true);
    // Both orders still evaluate; only the journal's fingerprint tells them apart.
    expect((await evaluateApproval({ ...input, command: command([b.ref, a.ref]) })).ok).toBe(true);
  });

  it('conflicts when a retry reuses the command ID with a different command version', async () => {
    const { input } = await scenario();
    const first = await decisionFingerprint(input.command);
    const other = await decisionFingerprint({ ...input.command, v: 2 } as never);
    expect(other.ok && first.ok && other.digest !== first.digest).toBe(true);
  });

  it('lets an honest retry match its committed fingerprint after state moved on', async () => {
    const { input } = await scenario();
    const committed = decision(await evaluateApproval(input));
    // Later the policy and binding move; re-evaluation would now be stale.
    expect(await evaluateApproval({ ...input, policyVersion: 4, binding: binding(1) })).toMatchObject({ ok: false });
    // The journal fingerprints the retried command alone and finds the committed result.
    expect(await decisionFingerprint(input.command)).toEqual({ ok: true, digest: committed.fingerprint });
  });

  it('keeps pending text out of every rejection', async () => {
    const { input, a, b } = await scenario();
    const edited = { ...b, content: text('SECRET pending text') };
    const results = await Promise.all([
      evaluateApproval({ ...input, pending: [a, edited] }),
      evaluateApproval({ ...input, pending: [a] }),
      evaluateApproval({ ...input, policyVersion: 9 }),
      evaluateApproval({ ...input, release: { ...input.release, payloadRef: 'https://example.com/p' } }),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('SECRET');
      expect(serialised).not.toContain(a.content.body);
      expect(Object.keys(result).sort()).toEqual(['code', 'field', 'ok', 'reason']);
    }
  });

  it.each([
    'https://example.com/payload',
    '/var/lib/khala/payload',
    '../payload',
    'file:payload',
    'ledger release',
    '',
  ])('refuses payloadRef %j that could become a URL, path or token carrier', async payloadRef => {
    const { input } = await scenario();
    const result = await evaluateApproval({ ...input, release: { ...input.release, payloadRef } });
    expect(result).toEqual({ ok: false, code: 'unavailable', reason: 'invalid_release', field: 'release.payloadRef' });
  });
});
