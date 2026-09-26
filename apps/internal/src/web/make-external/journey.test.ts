import fs from 'node:fs';
import path from 'node:path';
import type { OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import type { MakeExternalAction, MakeExternalJourneyView, MakeExternalRejection } from '@khala/contracts/messaging/make-external';
import { openImportedArchive } from '@khala/messaging/channels/history-import';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_IDS, FakeHostedProvider, IMPORT_LIMITS, type SeededChannel, human, seedInternalChannel,
} from '../../composition/fixtures/make-external-provider';
import { type ComposedMakeExternal, composeMakeExternal } from '../../composition/make-external';
import type { HistoryDrainCeiling } from '../../externalization/history-export';
import { openHistoryTransferLedger } from '../../externalization/transfer-ledger';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const owner = { ownerId: human.ownerId, participantId: human.participantId };

type Distribute<T> = T extends unknown ? Omit<T, 'operationId'> & Partial<Pick<MakeExternalAction, 'operationId'>> : never;
type ActionInput = Distribute<MakeExternalAction>;

type Setup = Readonly<{
  channel: SeededChannel;
  provider: FakeHostedProvider;
  composed: () => ComposedMakeExternal;
  /** A restarted server: a new journey over the same store and ledger. */
  restart: () => void;
  act: (action: ActionInput) =>
    Promise<Readonly<{ view: MakeExternalJourneyView; rejection: MakeExternalRejection | null }>>;
  view: () => Promise<MakeExternalJourneyView>;
  signIn: () => Promise<MakeExternalJourneyView>;
}>;

function setup(input: Readonly<{ messages?: readonly string[]; ceiling?: HistoryDrainCeiling }> = {}): Setup {
  const root = fs.mkdtempSync(path.join('/tmp', 'khala-make-external-'));
  const channel = seedInternalChannel({ root, messages: input.messages ?? [] });
  const ledgerDir = path.join(root, 'ledger');
  fs.mkdirSync(ledgerDir, { mode: 0o700 });
  const provider = new FakeHostedProvider();
  const make = () => {
    const ledger = openHistoryTransferLedger(ledgerDir);
    cleanups.push(() => ledger.close());
    return composeMakeExternal({
      handle: channel.handle, hosted: provider, sessions: provider, access: provider, bindings: provider, signIn: provider,
      destinationUrl: provider.destinationUrl,
      history: {
        transport: provider, ledger, limits: IMPORT_LIMITS, ceiling: input.ceiling ?? { maxDrainChunks: 64, drainDeadlineMs: 60_000 },
        now: () => Date.parse('2026-09-25T12:00:00Z'),
      },
    });
  };
  cleanups.push(() => {
    channel.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let composed = make();
  let operation = 0;
  const act: Setup['act'] = async action => {
    operation += 1;
    const result = await composed.journey.act(owner, channel.channelId, { operationId: `op-${operation}`, ...action } as MakeExternalAction);
    if (result.kind !== 'ok') throw new Error(`act failed: ${JSON.stringify(result)}`);
    return result;
  };
  const view = async () => {
    const result = await composed.journey.view(owner, channel.channelId);
    if (result.kind !== 'ok') throw new Error(`view failed: ${JSON.stringify(result)}`);
    return result.value;
  };
  return {
    channel, provider, composed: () => composed, restart: () => {
      composed = make();
    },
    act, view,
    signIn: async () => {
      await act({ kind: 'sign_in' });
      return view();
    },
  };
}

const allAgents = [...AGENT_IDS];

async function grantAll(s: Setup) {
  const view = await s.view();
  const handles = view.conversion!.agents.flatMap(agent => agent.status === 'requested' && agent.requestHandle ? [agent.requestHandle] : []);
  await s.act({ kind: 'grant', requestHandles: handles });
  return (await s.act({ kind: 'resume' })).view;
}

describe('before confirmation', () => {
  it('entering and cancelling changes nothing', async () => {
    const s = setup({ messages: ['hello'] });
    const entered = await s.view();
    expect(entered.signIn.status).toBe('signed_out');
    expect(entered.roster.map(agent => agent.participantId)).toEqual(allAgents);
    expect(entered.conversion).toBeNull();
    await s.act({ kind: 'cancel' });
    expect(s.provider.creates).toHaveLength(0);
    expect((await s.view()).sourceWrite).toBe('open');
    expect(s.channel.send('still active')).toBe(true);
  });

  it('refuses hosted steps until sign-in completes, and a failed sign-in leaves the channel active', async () => {
    const s = setup();
    const early = await s.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    expect(early.rejection).toBe('sign_in_required');
    expect(s.provider.creates).toHaveLength(0);

    s.provider.signInOutcome = 'pending';
    const pending = await s.act({ kind: 'sign_in' });
    expect(pending.view.signIn).toEqual({ status: 'pending', verificationUrl: 'https://khala.test/sign-in/1', failure: null });
    s.provider.signInOutcome = 'denied';
    const failed = await s.view();
    expect(failed.signIn).toEqual({ status: 'failed', verificationUrl: null, failure: 'denied' });
    expect(failed.sourceWrite).toBe('open');
    expect(s.channel.send('still active')).toBe(true);

    s.provider.signInOutcome = 'signed_in';
    expect((await s.signIn()).signIn.status).toBe('signed_in');
  });

  it('only the channel owner may see or change the journey', async () => {
    const s = setup();
    const stranger = { ownerId: 'owner-eve' as OwnerId, participantId: 'participant-eve' as ParticipantId };
    expect(await s.composed().journey.view(stranger, s.channel.channelId)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect((await s.composed().journey.act(stranger, s.channel.channelId, { kind: 'sign_in', operationId: 'op-x' })).kind).toBe('rejected');
  });
});

describe('start fresh', () => {
  it('creates one channel with the chosen visibility despite a lost create response, and copies nothing', async () => {
    const s = setup({ messages: ['old message'] });
    await s.signIn();
    s.provider.loseCreateResponses = 1;
    const started = await s.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'public', agents: allAgents });
    expect(started.rejection).toBeNull();
    expect(started.view.conversion).toMatchObject({ state: 'agents_pending', visibility: 'public', history: null });
    expect(s.provider.creates).toEqual([expect.objectContaining({ visibility: 'public' })]);
    expect(started.view.roster).toEqual([]);

    const ready = await grantAll(s);
    expect(ready.conversion!.canCommit).toBe(true);
    for (const id of allAgents) expect(s.provider.canExchange(id)).toBe(false);
    const committed = await s.act({ kind: 'commit' });
    expect(committed.view.conversion).toMatchObject({ state: 'externalized', destinationUrl: 'https://khala.test/channels/external-1' });
    expect(committed.view.sourceWrite).toBe('linked');
    for (const id of allAgents) expect(s.provider.canExchange(id)).toBe(true);
    expect(s.provider.parts.size).toBe(0);
    expect(s.provider.live).toEqual([]);
    expect(s.channel.send('after link')).toBe(false);
  });

  it('a retried confirmation never starts a second conversion', async () => {
    const s = setup();
    await s.signIn();
    const first = await s.act({ kind: 'start', operationId: 'op-confirm', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    const again = await s.act({ kind: 'start', operationId: 'op-confirm', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    expect(again.rejection).toBe('wrong_state');
    expect(again.view.conversion!.conversionId).toBe(first.view.conversion!.conversionId);
    expect(s.provider.creates).toHaveLength(1);
  });
});

describe('carry history', () => {
  const MESSAGES = Array.from({ length: 6 }, (_, index) => `message ${index + 1}: <b>bold</b>\n\`\`\`\ncode\n\`\`\``);

  /**
   * A producer that exactly keeps pace with the transfer: each put lets three messages
   * in, so every two-chunk step leaves a two-chunk backlog and catch-up never converges.
   * The backlog stays constant instead of growing each round, so the number of durable
   * writes is small and fixed rather than bounded only by how fast the runner is.
   */
  function steadyProducer(s: Setup) {
    let written = 0;
    s.provider.beforePut = () => {
      for (let index = 0; index < 3; index += 1) if (s.channel.send(`live ${written + 1}`)) written += 1;
    };
    return { written: () => written };
  }

  it('imports every record once despite lost acknowledgements, and never touches the live timeline', async () => {
    const s = setup({ messages: MESSAGES });
    await s.signIn();
    const lost = new Set<string>();
    s.provider.loseAck = txn => !lost.has(txn) && Boolean(lost.add(txn));
    let started = await s.act({ kind: 'start', historyMode: 'carry_history', visibility: 'secret', agents: allAgents });
    // A lost acknowledgement leaves its step for the next resume, as the browser polls.
    for (let attempt = 0; attempt < 10 && started.view.conversion!.state !== 'agents_pending'; attempt += 1) {
      started = await s.act({ kind: 'resume' });
    }
    const conversion = started.view.conversion!;
    expect(conversion.state).toBe('agents_pending');
    expect(conversion.history).toMatchObject({ phase: 'final_drain', outcome: 'converged', blocked: null });
    expect(conversion.history!.acknowledgedChunks).toBe(conversion.history!.chunkCount);
    // The final delta moved under a write pause that holds until the link commit.
    expect(started.view.sourceWrite).toBe('paused');
    expect(s.channel.send('during agents')).toBe(false);

    const archive = await openImportedArchive(s.provider, {
      roomId: conversion.destinationChannelId as RoomId, archiveId: `history.${conversion.conversionId}`,
      manifestDigest: conversion.history!.manifestDigest!, limits: IMPORT_LIMITS,
    });
    expect(archive.ok && archive.view.records.map(record => record.body)).toEqual(MESSAGES);
    expect(s.provider.parts.size).toBe(conversion.history!.chunkCount + 1);
    expect(s.provider.live).toEqual([]);

    await grantAll(s);
    const committed = await s.act({ kind: 'commit' });
    expect(committed.view.conversion!.state).toBe('externalized');
    expect(s.provider.creates).toHaveLength(1);
    expect(s.provider.live).toEqual([]);
  });

  it('asks for a paused drain when catch-up cannot converge, then finishes it', async () => {
    const s = setup({ messages: MESSAGES });
    await s.signIn();
    const producer = steadyProducer(s);
    const started = await s.act({ kind: 'start', historyMode: 'carry_history', visibility: 'private', agents: allAgents });
    expect(started.view.conversion).toMatchObject({ state: 'drain_required', history: { phase: 'catch_up', round: 3, outcome: 'drain_required' } });
    expect(started.view.sourceWrite).toBe('open');

    s.provider.beforePut = () => {};
    const drained = await s.act({ kind: 'drain' });
    expect(drained.view.conversion).toMatchObject({ state: 'agents_pending', history: { phase: 'final_drain', drainConfirmed: true } });
    expect(drained.view.sourceWrite).toBe('paused');
    const history = drained.view.conversion!.history!;
    const archive = await openImportedArchive(s.provider, {
      roomId: drained.view.conversion!.destinationChannelId as RoomId, archiveId: `history.${drained.view.conversion!.conversionId}`,
      manifestDigest: history.manifestDigest!, limits: IMPORT_LIMITS,
    });
    expect(archive.ok && archive.view.records.length).toBe(s.channel.count());
    // The workload is fixed, not paced by the runner: copy, three rounds and the drain move two chunks each.
    expect(producer.written()).toBe(24);
    expect(history.chunkCount).toBe(10);
  });

  it('a drain beyond its ceiling fails, resumes the internal channel and reports the orphan', async () => {
    const s = setup({ messages: MESSAGES, ceiling: { maxDrainChunks: 1, drainDeadlineMs: 60_000 } });
    await s.signIn();
    steadyProducer(s);
    await s.act({ kind: 'start', historyMode: 'carry_history', visibility: 'secret', agents: allAgents });
    s.provider.beforePut = () => {};
    const blocked = await s.act({ kind: 'drain' });
    expect(blocked.view.conversion).toMatchObject({ state: 'failed', failure: 'ceiling_exceeded', orphanDestinationChannelId: 'external-1' });
    expect(blocked.view.sourceWrite).toBe('open');
    expect(s.channel.send('active again')).toBe(true);

    const dismissed = await s.act({ kind: 'dismiss' });
    expect(dismissed.view.conversion).toBeNull();
    expect(dismissed.view.roster).toHaveLength(3);
  });
});

describe('agents, cancel and recovery', () => {
  it('cancelling after the channel exists keeps the internal channel active and reports the orphan', async () => {
    const s = setup();
    await s.signIn();
    await s.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    const cancelled = await s.act({ kind: 'cancel' });
    expect(cancelled.view.conversion).toMatchObject({ state: 'cancelled', orphanDestinationChannelId: 'external-1' });
    expect(cancelled.view.sourceWrite).toBe('open');
    expect(s.channel.send('still here')).toBe(true);
  });

  it('a blocked agent keeps commit disabled until it is retried or skipped', async () => {
    const s = setup();
    await s.signIn();
    s.provider.blocked.set('agent-tester', 'revoked');
    await s.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    const pending = await grantAll(s);
    expect(pending.conversion!.agents.find(agent => agent.participantId === 'agent-tester')).toMatchObject({ status: 'blocked', block: 'revoked' });
    expect(pending.conversion!.canCommit).toBe(false);
    expect((await s.act({ kind: 'commit' })).rejection).toBe('not_ready');

    s.provider.blocked.delete('agent-tester');
    const retried = await s.act({ kind: 'retry', participantId: 'agent-tester' });
    const tester = retried.view.conversion!.agents.find(agent => agent.participantId === 'agent-tester')!;
    expect(tester.status).toBe('requested');
    expect(retried.view.conversion!.canCommit).toBe(false);

    const skipped = await s.act({ kind: 'skip', participantId: 'agent-tester' });
    expect(skipped.view.conversion!.canCommit).toBe(true);
    expect((await s.act({ kind: 'commit' })).view.conversion!.state).toBe('externalized');
    expect(s.provider.canExchange('agent-tester')).toBe(false);
  });

  it('a failure after the link resumes forward and never reopens the internal channel', async () => {
    const s = setup();
    await s.signIn();
    s.provider.releaseFails.add('agent-reviewer');
    await s.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    await grantAll(s);
    const stuck = await s.act({ kind: 'commit' });
    expect(stuck.view.conversion!.state).toBe('activating');
    expect(stuck.view.sourceWrite).toBe('linked');
    expect((await s.act({ kind: 'cancel' })).rejection).toBe('wrong_state');
    expect(s.channel.send('reopened?')).toBe(false);

    s.provider.releaseFails.clear();
    const finished = await s.act({ kind: 'resume' });
    expect(finished.view.conversion!.state).toBe('externalized');
  });

  it('a restarted server still reports a cancelled conversion’s orphan until the human dismisses it', async () => {
    const s = setup();
    await s.signIn();
    await s.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    await s.act({ kind: 'cancel' });
    s.restart();
    expect((await s.view()).conversion).toMatchObject({ state: 'cancelled', orphanDestinationChannelId: 'external-1' });
    await s.act({ kind: 'dismiss' });
    s.restart();
    const after = await s.view();
    expect(after.conversion).toBeNull();
    expect(after.roster).toHaveLength(3);
  });

  it('a restarted server finishes activation after a new sign-in and never reopens the channel', async () => {
    const s = setup();
    await s.signIn();
    s.provider.releaseFails.add('agent-reviewer');
    await s.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'secret', agents: allAgents });
    await grantAll(s);
    expect((await s.act({ kind: 'commit' })).view.conversion!.state).toBe('activating');
    s.restart();
    s.provider.releaseFails.clear();
    expect((await s.act({ kind: 'resume' })).rejection).toBe('sign_in_required');
    expect((await s.act({ kind: 'cancel' })).rejection).toBe('wrong_state');
    expect(s.channel.send('reopened?')).toBe(false);
    await s.signIn();
    expect((await s.act({ kind: 'resume' })).view.conversion!.state).toBe('externalized');
  });

  it('a restarted server resumes the same conversion after a new sign-in', async () => {
    const s = setup({ messages: ['one', 'two'] });
    await s.signIn();
    const started = await s.act({ kind: 'start', historyMode: 'carry_history', visibility: 'secret', agents: allAgents });
    s.restart();
    const reloaded = await s.view();
    expect(reloaded.signIn.status).toBe('signed_out');
    expect(reloaded.conversion!.conversionId).toBe(started.view.conversion!.conversionId);
    expect((await s.act({ kind: 'resume' })).rejection).toBe('sign_in_required');
    await s.signIn();
    const resumed = await grantAll(s);
    expect(resumed.conversion!.canCommit).toBe(true);
    expect(s.provider.creates).toHaveLength(1);
  });
});
