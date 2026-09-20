// Test fixtures for connector storage: real contract values and a scratch state
// directory. Not part of the storage API: `fixtures/` is not exported by the package
// and production code cannot import it (check:boundaries).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ApprovalCommand, type BindingId, type CausalRootId, type CommandId, type DeliveryLimits, type DeliveryReceipt,
  type DeviceId, type EventId, type EventRef, type OwnerId, type ParticipantId, type ReceiptId, type ReleaseId,
  type ReleasedJob, type RoomId, type SessionBinding, decodeDeliveryLimits, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import type { UnavailableEventRef, UnavailableReason } from '@khala/contracts/messaging/index';
import type { PendingKey } from '../ledger';
import { newPayloadRef, sha256Digest } from '../payloads';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('fixture limits');
export const limits: DeliveryLimits = decodedLimits.value;

export const roomId = 'room_1' as RoomId;
export const ownerId = 'owner_b' as OwnerId;
export const bindingId = 'binding_b' as BindingId;
export const streamId = 'stream_s';

export function scratchDirectory(): { parent: string; state: string } {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'kha115-'));
  return { parent, state: path.join(parent, 'state') };
}

export function content(body: string): Uint8Array {
  return encodeMessageContent({ v: 1, kind: 'text', body });
}

export function eventRef(eventId: string, body: string): EventRef {
  return {
    v: 1,
    roomId,
    eventId: eventId as EventId,
    authorParticipantId: 'participant_a' as ParticipantId,
    authorDeviceId: 'device_a' as DeviceId,
    contentDigest: sha256Digest(content(body)),
  };
}

export function binding(generation = 0): SessionBinding {
  return {
    v: 1,
    bindingId,
    ownerId,
    agentParticipantId: 'participant_agent_b' as ParticipantId,
    deviceId: 'device_connector_b' as DeviceId,
    harness: 'codex',
    sessionId: generation === 0 ? 'session_s1' : `session_s1_g${generation}`,
    generation,
  };
}

export function pendingInput(eventId: string, body: string, generation = 0) {
  const key: PendingKey = { roomId, eventId: eventId as EventId, recipientBindingId: bindingId, recipientGeneration: generation };
  return { key, event: eventRef(eventId, body), plaintext: content(body), receivedAt: '2026-09-18T10:00:00Z', streamId };
}

export function unavailableInput(eventId: string, reason: UnavailableReason = 'withheld', generation = 0) {
  const key: PendingKey = { roomId, eventId: eventId as EventId, recipientBindingId: bindingId, recipientGeneration: generation };
  const { v, authorParticipantId, authorDeviceId } = eventRef(eventId, '');
  const ref: UnavailableEventRef = { v, roomId, eventId: eventId as EventId, authorParticipantId, authorDeviceId };
  return { key, ref, reason, receivedAt: '2026-09-18T10:00:00Z', streamId };
}

export function approval(commandId: string, selection: readonly EventRef[], generation = 0): ApprovalCommand {
  return {
    v: 1,
    commandId: commandId as CommandId,
    roomId,
    bindingId,
    expectedPolicyVersion: 1,
    expectedBindingGeneration: generation,
    selection,
    issuedAt: '2026-09-18T10:01:00Z',
  };
}

export function release(command: ApprovalCommand, forBinding: SessionBinding, payload: Uint8Array, releaseId = 'release_r7'): ReleasedJob {
  const released = releaseFromApproval({
    approval: command,
    items: command.selection,
    binding: forBinding,
    policyVersion: command.expectedPolicyVersion,
    release: {
      releaseId: releaseId as ReleaseId,
      payloadRef: newPayloadRef(),
      payloadDigest: sha256Digest(payload),
      causalRootId: 'cause_1' as CausalRootId,
    },
  });
  if (!released.ok) throw new Error(`fixture release: ${released.code}`);
  return released.value;
}

export function commandRecord(command: ApprovalCommand, releaseId: string, inputDigest = sha256Digest(content(command.commandId))) {
  return {
    ownerId,
    commandId: command.commandId,
    inputDigest,
    command,
    result: { ok: true as const, releaseIds: [releaseId as ReleaseId] },
  };
}

export function receipt(releaseId: string, kind: DeliveryReceipt['kind'], generation = 0, receiptId = `receipt_${kind}`): DeliveryReceipt {
  return {
    v: 1,
    receiptId: receiptId as ReceiptId,
    releaseId: releaseId as ReleaseId,
    bindingId,
    generation,
    kind,
    observedAt: '2026-09-18T10:02:00Z',
    source: 'connector',
    evidenceRef: null,
    errorCode: kind === 'failed' ? 'harness_rejected' : null,
  };
}
