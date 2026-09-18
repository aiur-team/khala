import { describe, expect, expectTypeOf, it } from 'vitest';
import approval from '../../fixtures/delivery/approval.json';
import {
  type ApprovalPort, type ApprovalResult, type OwnerAuthority, type PolicyAck,
  decodeApprovalCommand, decodePolicyAck, decodePolicySetCommand,
  sameApprovalCommandInput, samePolicySetCommandInput,
} from './commands';
import { decodeDeliveryLimits } from './decode';
import * as commandExports from './commands';

const decodedLimits = decodeDeliveryLimits(approval.limits);
if (!decodedLimits.ok) throw new Error('approval fixture limits must decode');
const limits = decodedLimits.value;

function decodedValue<T>(decoded: { ok: true; value: T } | { ok: false }): T {
  if (!decoded.ok) throw new Error('fixture must decode');
  return decoded.value;
}

const command = () => decodedValue(decodeApprovalCommand(approval.approvalCommand, limits));
const policy = () => decodedValue(decodePolicySetCommand(approval.policySetCommand));

describe('approval command', () => {
  it('decodes an exact, ordered selection without normalising it', () => {
    const decoded = decodeApprovalCommand(approval.approvalCommand, limits);
    expect(decoded).toEqual({ ok: true, value: approval.approvalCommand });
    if (decoded.ok) {
      expect(decoded.value.selection.map(ref => ref.eventId)).toEqual(['event-a-7', 'event-a-8']);
    }
  });

  it('requires a nonempty configured-bounded selection', () => {
    expect(decodeApprovalCommand({ ...approval.approvalCommand, selection: [] }, limits)).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'selection',
    });
    expect(decodeApprovalCommand({
      ...approval.approvalCommand,
      selection: [...approval.approvalCommand.selection, {
        ...approval.approvalCommand.selection[0],
        eventId: 'event-a-9',
      }],
    }, limits)).toEqual({ ok: false, code: 'limit_exceeded', field: 'selection' });
  });

  it('rejects a duplicate event identity even when its digest changes', () => {
    const duplicate = {
      ...approval.approvalCommand.selection[0],
      contentDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    expect(decodeApprovalCommand({ ...approval.approvalCommand, selection: [
      approval.approvalCommand.selection[0], duplicate,
    ] }, limits)).toEqual({ ok: false, code: 'invalid_field', field: 'selection[1].eventId' });
  });

  it('requires every selected event to belong to the command room', () => {
    const otherRoom = { ...approval.approvalCommand.selection[0], roomId: 'room-other' };
    expect(decodeApprovalCommand({ ...approval.approvalCommand, selection: [otherRoom] }, limits)).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'selection[0].roomId',
    });
  });

  it('rejects unknown or missing protocol-critical fields and unsupported versions', () => {
    expect(decodeApprovalCommand({ ...approval.approvalCommand, surprise: true }, limits).ok).toBe(false);
    const withoutCommandId = structuredClone(approval.approvalCommand) as Record<string, unknown>;
    delete withoutCommandId.commandId;
    expect(decodeApprovalCommand(withoutCommandId, limits).ok).toBe(false);
    expect(decodeApprovalCommand({ ...approval.approvalCommand, v: 2 }, limits)).toEqual({
      ok: false,
      code: 'invalid_version',
      field: 'v',
    });
  });

  it.each([
    ['expectedPolicyVersion', -1],
    ['expectedPolicyVersion', Number.MAX_SAFE_INTEGER + 1],
    ['expectedBindingGeneration', -1],
    ['expectedBindingGeneration', 0.5],
  ])('rejects unsafe %s values', (field, value) => {
    expect(decodeApprovalCommand({ ...approval.approvalCommand, [field]: value }, limits).ok).toBe(false);
  });

  it.each(['2026-09-18T00:00:00+00:00', '2026-02-30T00:00:00Z', 'not-a-date'])
    ('requires issuedAt to be a real UTC timestamp: %s', issuedAt => {
      expect(decodeApprovalCommand({ ...approval.approvalCommand, issuedAt }, limits).ok).toBe(false);
    });

  it('compares the entire canonical input and preserves selection order', () => {
    const original = command();
    const same = decodedValue(decodeApprovalCommand(approval.sameIdSameInput, limits));
    const reordered = decodedValue(decodeApprovalCommand(approval.sameIdChangedInput, limits));
    expect(original.commandId).toBe(same.commandId);
    expect(sameApprovalCommandInput(original, same)).toBe(true);
    expect(original.commandId).toBe(reordered.commandId);
    expect(sameApprovalCommandInput(original, reordered)).toBe(false);
  });

  it('accepts a well-formed changed digest structurally without claiming the content is current', () => {
    expect(decodeApprovalCommand(approval.staleContentCommand, limits).ok).toBe(true);
    expect(approval.approvalResults.invalidContent).toEqual({ ok: false, code: 'stale_content' });
  });
});

describe('trusted authority and approval results', () => {
  it('exposes authority only as a trusted composition input', async () => {
    const authority = approval.authority as OwnerAuthority;
    const port: ApprovalPort = {
      approve: async () => approval.approvalResults.approved as unknown as ApprovalResult,
      setPolicy: async () => approval.policyAcks.effective as PolicyAck,
    };
    expect(await port.approve(authority, command())).toEqual(approval.approvalResults.approved);
    expectTypeOf(authority.authorizationId).toBeString();
    expect(commandExports).not.toHaveProperty('decodeOwnerAuthority');
  });

  it('keeps command identity owner-scoped in the fixture examples', () => {
    expect(approval.authority.ownerId).not.toBe(approval.otherOwnerAuthority.ownerId);
    expect(approval.approvalResults.crossOwnerBinding).toEqual({ ok: false, code: 'forbidden' });
  });

  it('separates ordinary rejection from an ambiguous persistence outcome', () => {
    expect(approval.approvalResults.stalePolicy).toEqual({ ok: false, code: 'stale_policy' });
    expect(approval.approvalResults.outcomeUnknown).toEqual({
      ok: false,
      code: 'outcome_unknown',
      operationId: 'approval-operation-1',
    });
  });
});

describe('policy set command', () => {
  it('decodes the exact future-policy request without selecting an automation default', () => {
    expect(decodePolicySetCommand(approval.policySetCommand)).toEqual({
      ok: true,
      value: approval.policySetCommand,
    });
  });

  it('strictly checks version, mode, paused, safe counters and issuedAt', () => {
    for (const changed of [
      { v: 2 },
      { mode: 'sometimes' },
      { paused: 0 },
      { expectedPolicyVersion: -1 },
      { expectedBindingGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { issuedAt: '2026-09-18T00:00:00+00:00' },
      { unknown: true },
    ]) {
      expect(decodePolicySetCommand({ ...approval.policySetCommand, ...changed }).ok).toBe(false);
    }
  });

  it('compares every exact input field', () => {
    const original = policy();
    expect(samePolicySetCommandInput(original, { ...original })).toBe(true);
    expect(samePolicySetCommandInput(original, { ...original, paused: !original.paused })).toBe(false);
    expect(samePolicySetCommandInput(original, { ...original, mode: 'auto' })).toBe(false);
  });
});

describe('policy acknowledgement', () => {
  it.each(Object.entries(approval.policyAcks))('decodes fixture $0', (_name, input) => {
    expect(decodePolicyAck(input)).toEqual({ ok: true, value: input });
  });

  it('requires an effective acknowledgement to match non-null versions with no error', () => {
    const effective = approval.policyAcks.effective;
    for (const changed of [
      { requestedVersion: null },
      { effectiveVersion: null },
      { effectiveVersion: effective.effectiveVersion + 1 },
      { errorCode: 'outcome_unknown' },
    ]) {
      expect(decodePolicyAck({ ...effective, ...changed }).ok).toBe(false);
    }
  });

  it('requires rejected to carry a safe allowlisted error', () => {
    const rejected = approval.policyAcks.stalePolicy;
    expect(decodePolicyAck({ ...rejected, errorCode: null }).ok).toBe(false);
    expect(decodePolicyAck({ ...rejected, errorCode: 'raw provider detail' }).ok).toBe(false);
  });

  it('never turns an ambiguous outcome into effective state', () => {
    const ambiguous = approval.policyAcks.outcomeUnknown;
    expect(decodePolicyAck(ambiguous)).toEqual({ ok: true, value: ambiguous });
    expect(decodePolicyAck({
      ...ambiguous,
      connectorState: 'effective',
      requestedVersion: 4,
      effectiveVersion: 4,
    }).ok).toBe(false);
  });

  it('preserves null versions when no authoritative revision was observed', () => {
    const decoded = decodePolicyAck(approval.policyAcks.outcomeUnknown);
    expect(decoded).toEqual({ ok: true, value: approval.policyAcks.outcomeUnknown });
    if (decoded.ok) {
      expect(decoded.value.requestedVersion).toBeNull();
      expect(decoded.value.effectiveVersion).toBeNull();
    }
  });
});
