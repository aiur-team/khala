import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createHostedCodexHarness } from '@khala/connector-app/composition/agent/hosted-codex';
import { routeSnapshot, supportedRoute } from '@khala/connector/dispatch/budget';
import {
  type ApprovalCommand, type EventRef, type SessionBinding, decodeDeliveryLimits, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import { nativeCliCapabilities } from '@khala/harnesses/codex/capabilities';
import { encodeReleasePayload } from '@khala/policy/release/index';
import { openInbox } from '../cli/inbox.js';

const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

it('carries one approved proof-key release through native queue, inbox read, and later ACK', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-codex-delivery-'));
  const binding: SessionBinding = { v: 1, bindingId: 'binding_codex_delivery' as never,
    ownerId: 'owner_codex_delivery' as never, agentParticipantId: 'agent_codex_delivery' as never,
    deviceId: 'device_codex_delivery' as never, harness: 'proof-key',
    sessionId: 'agent_approved_key', generation: 0 };
  const content = { v: 1 as const, kind: 'text' as const, body: 'isolated approved message' };
  const ref: EventRef = { v: 1, roomId: 'room_delivery' as never, eventId: 'event_delivery' as never,
    authorParticipantId: 'human_delivery' as never, authorDeviceId: 'device_human' as never,
    contentDigest: digest(encodeMessageContent(content)) };
  const approval: ApprovalCommand = { v: 1, commandId: 'approval_delivery' as never,
    roomId: ref.roomId, bindingId: binding.bindingId, expectedPolicyVersion: 1,
    expectedBindingGeneration: 0, selection: [ref], issuedAt: '2026-10-01T00:00:00Z' };
  const encoded = encodeReleasePayload({ releaseId: 'release_delivery' as never,
    bindingId: binding.bindingId, generation: 0, policyVersion: 1, items: [{ ref, content }] });
  if (!encoded.ok) throw new Error(`payload fixture: ${encoded.field}`);
  const released = releaseFromApproval({ approval, items: [ref], binding, policyVersion: 1,
    release: { releaseId: 'release_delivery' as never, payloadRef: 'payload_delivery',
      payloadDigest: digest(encoded.bytes), causalRootId: 'cause_delivery' as never } });
  if (!released.ok) throw new Error(`release fixture: ${released.code}`);
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
  if (!decoded.ok) throw new Error('limits fixture');
  const native = nativeCliCapabilities('0.159.3', decoded.value);
  const proof = { status: 'proven' as const, route: 'codex-hook', testedVersion: '0.159.3',
    evidenceRef: 'isolated-hook-proof', evidenceRevision: 'isolated-hook-revision', reason: null };
  const options = { stateDirectory: path.join(root, 'inbox'), bindingId: binding.bindingId,
    generation: binding.generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 20 };
  const harness = createHostedCodexHarness({ binding,
    claim: { harness: 'codex', sessionId: 'native_codex_thread', workdir: '/project' },
    sessionInspection: { inspect: async () => ({ kind: 'verified' as const,
      session: { harness: 'codex', sessionId: 'native_codex_thread', generation: 0 }, capabilities: native }) },
    current: async () => true, resolveExecutable: async () => '/bin/true',
    inspectHooks: async () => ({ ...native, modes: { ...native.modes, sync: proof } }),
    openInbox: async () => openInbox(options),
  });
  try {
    const capabilities = await harness.inspect(binding);
    expect(supportedRoute(capabilities, binding)).toBe(true);
    expect(routeSnapshot(capabilities, binding, 'sync', proof.evidenceRevision)).not.toBeNull();
    expect(await harness.submit({ job: released.value, payload: encoded.bytes })).toMatchObject({
      kind: 'harness_queued', releaseId: released.value.releaseId });
    expect(await harness.submit({ job: released.value, payload: encoded.bytes })).toMatchObject({
      kind: 'outcome_unknown', releaseId: released.value.releaseId });
    const inbox = await openInbox(options);
    const reader = await inbox.acquireCallConsumer!();
    try {
      const first = await reader.readBatch({ maxBytes: 64 * 1024 });
      expect(first?.items.map(item => item.record.releaseId)).toEqual(['release_delivery']);
      expect(first?.items[0]?.payload).toEqual(encoded.bytes);
      expect((await reader.readBatch({ maxBytes: 64 * 1024 }))?.token).toBe(first?.token);
      expect(await reader.readBatch({ maxBytes: 64 * 1024, acknowledgeToken: first!.token })).toBeNull();
      expect((await inbox.status()).cursor.releaseId).toBe('release_delivery');
    } finally { await reader.release(); }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
