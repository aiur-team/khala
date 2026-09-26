// The verdict over durable evidence. Each case starts from the evidence of a
// passing offline run and breaks one fact, the way a wrong implementation would.

import { describe, expect, it } from 'vitest';
import { planModes } from '../../../scripts/acceptance/profile';
import { runAcceptance } from '../../../scripts/acceptance/runner';
import type { ChannelSnapshot, TimelineEvent } from '../../../scripts/acceptance/types';
import { type VerifyInput, verifyRun } from '../../../scripts/acceptance/verify';
import { RUN_ID, createWorld } from './fakes';

async function passingInput(): Promise<VerifyInput> {
  const world = createWorld();
  let timeline: readonly TimelineEvent[] = [];
  const start = world.deps.launcher.start;
  const deps = {
    ...world.deps,
    launcher: {
      async start(resume: string | null) {
        const server = await start(resume);
        return {
          ...server,
          async owner() {
            const owner = await server.owner();
            return { ...owner, timeline: async () => (timeline = await owner.timeline()) };
          },
        };
      },
    },
  };
  const report = await runAcceptance(deps, { profile: world.profile, runId: RUN_ID, resume: null });
  expect(report.verdict).toBe('pass');
  const snapshot = await world.deps.snapshot.read('channel_offline');
  return {
    profile: world.profile, plan: planModes(world.profile), markers: world.markers, roles: report.roles,
    issues: [...world.issues.values()], pullRequests: [], timeline, snapshot, stop: report.stop,
    launcherClosed: true, modeResults: new Map(report.modes.runnable.map(mode => [mode, { kind: 'effective' as const }])),
  };
}

function statusOf(input: VerifyInput, name: string) {
  return verifyRun(input).checks.find(entry => entry.check === name)?.status;
}

function withSnapshot(input: VerifyInput, change: (snapshot: ChannelSnapshot) => ChannelSnapshot): VerifyInput {
  return { ...input, snapshot: change(input.snapshot!) };
}

describe('acceptance verdict', () => {
  it('passes only when every check passes', async () => {
    const input = await passingInput();
    expect(verifyRun(input).verdict).toBe('pass');
    expect(verifyRun({ ...input, snapshot: null }).verdict).not.toBe('pass');
  });

  it('does not pass handshake sends without event-linked acknowledgements', async () => {
    const input = await passingInput();
    const unlinked = withSnapshot(input, snapshot => ({
      ...snapshot, receipts: snapshot.receipts.map(receipt => ({ ...receipt, eventIds: ['event_unrelated'] })),
    }));
    expect(statusOf(unlinked, 'read-ack:steer')).toBe('unproven');
    expect(verifyRun(unlinked).verdict).toBe('unproven');
    // A read observed only after the reader already answered is not a read before replying.
    const late = withSnapshot(input, snapshot => ({
      ...snapshot, receipts: snapshot.receipts.map(receipt => ({ ...receipt, observedAt: '2026-09-26T23:00:00.000Z' })),
    }));
    expect(verifyRun(late).verdict).not.toBe('pass');
    // A delivery-side receipt kind is not the agent's own acknowledgement.
    const delivered = withSnapshot(input, snapshot => ({
      ...snapshot, receipts: snapshot.receipts.map(receipt => ({ ...receipt, kind: 'transport_written' })),
    }));
    expect(verifyRun(delivered).verdict).not.toBe('pass');
  });

  it('fails when one binding stands in for both roles', async () => {
    const input = await passingInput();
    const shared = { ...input, roles: input.roles.map(role => ({ ...role, target: input.roles[0]!.target })) };
    expect(statusOf(shared, 'binding:b')).toBe('fail');
    expect(verifyRun(shared).verdict).toBe('fail');
  });

  it('fails when the binding belongs to another native session than the ticket\'s', async () => {
    const input = await passingInput();
    const other = { ...input, roles: input.roles.map(role => (role.role === 'b' ? { ...role, session: { ...role.session!, sessionId: 'someone-else' } } : role)) };
    expect(statusOf(other, 'binding:b')).toBe('fail');
  });

  it('fails when the recorded model is not the profile\'s', async () => {
    const input = await passingInput();
    const other = { ...input, roles: input.roles.map(role => ({ ...role, session: { ...role.session!, model: 'deepseek-direct' } })) };
    expect(statusOf(other, 'native-session:a')).toBe('fail');
  });

  it('fails a duplicate client transaction in the store', async () => {
    const input = await passingInput();
    const duplicated = withSnapshot(input, snapshot => ({
      ...snapshot, events: [...snapshot.events, { ...snapshot.events.at(-1)!, eventId: 'event_dupe', sequence: 999 }],
    }));
    expect(statusOf(duplicated, 'store-integrity')).toBe('fail');
  });

  it('fails a handshake event the store attributes to someone else', async () => {
    const input = await passingInput();
    const forged = withSnapshot(input, snapshot => ({
      ...snapshot, events: snapshot.events.map(event => (event.authorParticipantId === 'participant_b' ? { ...event, authorParticipantId: 'participant_a' } : event)),
    }));
    expect(verifyRun(forged).verdict).toBe('fail');
  });

  it('fails a runner-linked pull request and a launcher that did not close', async () => {
    const input = await passingInput();
    expect(statusOf({ ...input, pullRequests: [77] }, 'no-pull-request')).toBe('fail');
    expect(statusOf({ ...input, launcherClosed: false }, 'launcher-closed')).toBe('fail');
  });

  it('fails a Stop that answered with a partial outcome', async () => {
    const input = await passingInput();
    const reply = input.stop!.reply!;
    if (reply.kind === 'refused') throw new Error('expected a stopped reply');
    const partial = { ...input, stop: { ...input.stop!, reply: { kind: 'partial' as const, stopped: reply.stopped.slice(0, 1), remaining: reply.stopped.slice(1) } } };
    expect(statusOf(partial, 'stop')).toBe('fail');
    // Both recorded bindings stopped, but the server still reports one it could not revoke.
    const leftover = { bindingId: 'binding_other', generation: 1, agentParticipantId: 'participant_other' };
    const unfinished = { ...input, stop: { ...input.stop!, reply: { kind: 'partial' as const, stopped: reply.stopped, remaining: [leftover] } } };
    expect(statusOf(unfinished, 'stop')).toBe('fail');
  });
});
