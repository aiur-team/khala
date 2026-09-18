import { describe, expect, expectTypeOf, it } from 'vitest';
import exact from '../../fixtures/delivery/exact-release.json';
import { type SessionBinding, decodeSessionBinding } from './binding';
import {
  type ApprovalCommand, type ApprovalPort, type ApprovalResult, type OwnerAuthority, type PolicyAck, type PolicySetCommand,
  decodeApprovalCommand, decodePolicySetCommand, sameApprovalCommandInput, samePolicySetCommandInput,
} from './commands';
import * as commandExports from './commands';
import { decodeDeliveryLimits } from './decode';
import type { EventRef } from './events';
import type { HarnessPort } from './harness';
import {
  type ReleaseEnvelope, type ReleasedJob, type UnverifiedReleasedJob,
  decodeReleasedJob, releaseFromApproval, verifyReleasedJob,
} from './jobs';

function decodedValue<T>(decoded: { ok: true; value: T } | { ok: false }): T {
  if (!decoded.ok) throw new Error('fixture must decode');
  return decoded.value;
}

const limits = decodedValue(decodeDeliveryLimits(exact.limits));
const command = (): ApprovalCommand => decodedValue(decodeApprovalCommand(exact.approvalCommand, limits));
const policy = (): PolicySetCommand => decodedValue(decodePolicySetCommand(exact.policySetCommand));
const binding = (): SessionBinding => decodedValue(decodeSessionBinding(exact.binding));
const release = exact.release as ReleaseEnvelope;
const otherDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('approval command', () => {
  it('decodes an exact, ordered selection without normalising it', () => {
    const decoded = decodeApprovalCommand(exact.approvalCommand, limits);
    expect(decoded).toEqual({ ok: true, value: exact.approvalCommand });
    if (decoded.ok) expect(decoded.value.selection.map(ref => ref.eventId)).toEqual(['event-a-7', 'event-a-8']);
  });

  it('accepts a well-formed changed digest structurally; only release against the approval refuses it', () => {
    const changed = structuredClone(exact.approvalCommand);
    changed.selection[0]!.contentDigest = otherDigest;
    expect(decodeApprovalCommand(changed, limits).ok).toBe(true);
  });
});

describe('approval command input equality', () => {
  // One case per compared field: a stored result must not answer any other input.
  const substitutions: { [Field in keyof ApprovalCommand]: unknown } = {
    v: 2,
    commandId: 'approve-2',
    roomId: 'room-2',
    bindingId: 'bind-b-2',
    expectedPolicyVersion: 4,
    expectedBindingGeneration: 1,
    selection: exact.approvalCommand.selection.slice(0, 1),
    issuedAt: '2026-09-18T00:00:01Z',
  };

  it('compares every command field', () => {
    expect(Object.keys(substitutions).sort()).toEqual(Object.keys(exact.approvalCommand).sort());
  });

  it.each(Object.entries(substitutions))('refuses a command differing only in %s', (field, value) => {
    const changed = { ...command(), [field]: value } as ApprovalCommand;
    expect(sameApprovalCommandInput(command(), changed)).toBe(false);
    expect(sameApprovalCommandInput(changed, command())).toBe(false);
  });

  // Selection entries compare as whole references, not by event ID alone.
  const refSubstitutions: { [Field in keyof EventRef]: unknown } = {
    v: 2,
    roomId: 'room-2',
    eventId: 'event-a-9',
    authorParticipantId: 'agent-x',
    authorDeviceId: 'dev-x',
    contentDigest: otherDigest,
  };

  it('compares every selected reference field', () => {
    expect(Object.keys(refSubstitutions).sort()).toEqual(Object.keys(exact.eventRef).sort());
  });

  it.each(Object.entries(refSubstitutions))('refuses a selection entry differing only in %s', (field, value) => {
    const original = command();
    const selection = [{ ...original.selection[0]!, [field]: value } as EventRef, original.selection[1]!];
    const changed = { ...original, selection };
    expect(sameApprovalCommandInput(original, changed)).toBe(false);
    expect(sameApprovalCommandInput(changed, original)).toBe(false);
  });

  it('refuses a reordered selection', () => {
    const original = command();
    const reordered = { ...original, selection: [...original.selection].reverse() };
    expect(sameApprovalCommandInput(original, reordered)).toBe(false);
  });

  it('matches an identical command', () => {
    expect(sameApprovalCommandInput(command(), command())).toBe(true);
  });
});

describe('policy set command input equality', () => {
  const substitutions: { [Field in keyof PolicySetCommand]: unknown } = {
    v: 2,
    commandId: 'policy-2',
    roomId: 'room-2',
    bindingId: 'bind-b-2',
    peerParticipantId: 'agent-x',
    expectedPolicyVersion: 4,
    expectedBindingGeneration: 1,
    mode: 'auto',
    paused: true,
    issuedAt: '2026-09-18T00:00:01Z',
  };

  it('compares every command field', () => {
    expect(Object.keys(substitutions).sort()).toEqual(Object.keys(exact.policySetCommand).sort());
  });

  it.each(Object.entries(substitutions))('refuses a command differing only in %s', (field, value) => {
    const changed = { ...policy(), [field]: value } as PolicySetCommand;
    expect(samePolicySetCommandInput(policy(), changed)).toBe(false);
    expect(samePolicySetCommandInput(changed, policy())).toBe(false);
  });

  it('matches an identical command', () => {
    expect(samePolicySetCommandInput(policy(), policy())).toBe(true);
  });
});

describe('releaseFromApproval', () => {
  const input = () => ({
    approval: command(),
    items: command().selection,
    binding: binding(),
    policyVersion: exact.approvalCommand.expectedPolicyVersion,
    release,
  });

  it('builds exactly the fixture release, carrying its approval', () => {
    expect(releaseFromApproval(input())).toEqual({ ok: true, value: exact.releasedJob });
  });

  it('AE1: rejects a release whose selected digest changed', () => {
    const items = [{ ...command().selection[0]!, contentDigest: otherDigest } as EventRef, command().selection[1]!];
    expect(releaseFromApproval({ ...input(), items })).toEqual({ ok: false, code: 'stale_content', field: 'items[0]' });
  });

  it('AE1: rejects a release to the next binding generation', () => {
    expect(releaseFromApproval({ ...input(), binding: { ...binding(), generation: 1 } }))
      .toEqual({ ok: false, code: 'stale_binding', field: 'binding.generation' });
  });

  it('rejects a partial release rather than truncating the approval', () => {
    expect(releaseFromApproval({ ...input(), items: command().selection.slice(0, 1) }))
      .toEqual({ ok: false, code: 'selection_mismatch', field: 'items' });
  });

  it('re-verifies a decoded release only against its recorded approval', () => {
    const decoded = decodedValue(decodeReleasedJob(exact.releasedJob, limits));
    expect(verifyReleasedJob(decoded, command())).toEqual({ ok: true, value: exact.releasedJob });
    const other = { ...command(), commandId: 'approve-2' as ApprovalCommand['commandId'] };
    expect(verifyReleasedJob(decoded, other)).toEqual({ ok: false, code: 'approval_mismatch', field: 'approval.commandId' });
  });

  it('only a verified release reaches a harness', () => {
    expectTypeOf<UnverifiedReleasedJob>().not.toMatchTypeOf<ReleasedJob>();
    expectTypeOf<ReleasedJob>().toMatchTypeOf<UnverifiedReleasedJob>();
    expectTypeOf<Parameters<HarnessPort['submit']>[0]['job']>().toEqualTypeOf<ReleasedJob>();
    expectTypeOf<Parameters<HarnessPort['reconcile']>[0]>().toEqualTypeOf<ReleasedJob>();
    const unverified = decodedValue(decodeReleasedJob(exact.releasedJob, limits));
    // @ts-expect-error A decoded release with every field well-typed is still unverified.
    const forged: ReleasedJob = unverified;
    expect(forged).toBeDefined();
  });
});

describe('trusted authority and approval port', () => {
  it('exposes authority only as a trusted composition input', async () => {
    const authority = {
      ownerId: 'owner-b',
      issuer: 'https://identity.example.test',
      subject: 'owner-b-subject',
      authenticatedAt: '2026-09-18T00:00:00Z',
      authorizationId: 'authorization-b-1',
    } as OwnerAuthority;
    const port: ApprovalPort = {
      approve: async () => ({ ok: true, releaseIds: [release.releaseId] }) as ApprovalResult,
      setPolicy: async () => exact.policyAck as PolicyAck,
    };
    expect(await port.approve(authority, command())).toEqual({ ok: true, releaseIds: ['release-1'] });
    expect(commandExports).not.toHaveProperty('decodeOwnerAuthority');
  });
});
