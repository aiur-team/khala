import * as delivery from '@khala/contracts/delivery/index';
import * as messaging from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import exact from '../../packages/contracts/fixtures/delivery/exact-release.json';
import intro from '../../packages/contracts/fixtures/messaging/exact-intro.json';
import { createOwnerFixture, nextGeneration } from '../e2e/harness/owners';
import { controlsFor, fixtureLimits } from './subjects';
import { releaseFor } from './suites';

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('expected a decoded value');
  return result.value;
}

describe('owner fixtures match the KHA-105/106 literals', () => {
  const b = createOwnerFixture('b', {
    ...controlsFor('b'),
    harness: exact.binding.harness,
    sessionId: exact.binding.sessionId,
    generation: exact.binding.generation,
  });

  it('builds B exactly as the worked delivery binding', () => {
    expect(b.binding).toEqual(exact.binding);
    expect(b.agentParticipantId).toBe(exact.binding.agentParticipantId);
    expect(b.humanParticipantId).not.toBe(b.agentParticipantId);
  });

  it('decodes each owner binding identically in both contract domains', () => {
    for (const seed of ['a', 'b', 'c']) {
      const owner = createOwnerFixture(seed, controlsFor(seed));
      const wire = JSON.parse(JSON.stringify(owner.binding));
      expect(value(messaging.decodeSessionBinding(wire))).toEqual(value(delivery.decodeSessionBinding(wire)));
    }
  });

  it('keeps E7 (authored by A) and its digest identical across domains', () => {
    const a = createOwnerFixture('a', controlsFor('a'));
    expect(exact.eventRef.authorParticipantId).toBe(a.agentParticipantId);
    expect(exact.eventRef.authorDeviceId).toBe(a.deviceId);
    expect(exact.eventRef.contentDigest).toBe(intro.encoding.contentDigest);
    expect(value(messaging.decodeEventRef(exact.eventRef))).toEqual(value(delivery.decodeEventRef(exact.eventRef)));
  });

  it('treats a re-armed binding as stale in both domains', () => {
    const rearmed = nextGeneration(b);
    expect(rearmed.binding.bindingId).toBe(b.binding.bindingId);
    expect(delivery.sameSessionBinding(b.binding, rearmed.binding)).toBe(false);
    expect(messaging.sameSessionBinding(b.binding as never, rearmed.binding as never)).toBe(false);
    const event = value(delivery.decodeEventRef(exact.eventRef));
    const approval = { ...value(delivery.decodeApprovalCommand(exact.approvalCommand, fixtureLimits)), selection: [event] };
    const stale = delivery.releaseFromApproval({
      approval,
      items: [event],
      binding: rearmed.binding,
      policyVersion: approval.expectedPolicyVersion,
      release: exact.release as never,
    });
    expect(stale).toEqual({ ok: false, code: 'stale_binding', field: 'binding.generation' });
  });

  it('releases the same event to different recipients as distinct jobs', () => {
    const c = createOwnerFixture('c', controlsFor('c'));
    const bFake = createOwnerFixture('b', controlsFor('b'));
    const event = value(delivery.decodeEventRef(exact.eventRef));
    const payload = new TextEncoder().encode('e7');
    const forB = releaseFor(bFake, [event], payload, 'release-b', fixtureLimits);
    const forC = releaseFor(c, [event], payload, 'release-c', fixtureLimits);
    expect(delivery.sameEventRef(forB.events[0]!, forC.events[0]!)).toBe(true);
    expect(forB.binding.ownerId).not.toBe(forC.binding.ownerId);
    expect(forB.binding.sessionId).not.toBe(forC.binding.sessionId);
  });
});
