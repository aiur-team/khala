// Make external, end to end over fakes: a real internal channel (SQLite store,
// conversion journal, service, history export and journey) converts into a fake hosted
// channel whose provider loses responses. The re-invited agents are the harness
// reference connectors and fake model sessions; they hear the destination's live
// timeline, including its backlog when their binding is released, exactly as a joining
// member syncs a channel. Imported history must reach none of them.

import fs from 'node:fs';
import path from 'node:path';
import type { EventRef } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/index';
import type { MakeExternalAction, MakeExternalJourneyView } from '@khala/contracts/messaging/make-external';
import { afterEach, describe, expect, it } from 'vitest';
import { openImportedArchive } from '../../../packages/messaging/src/channels/history-import';
import {
  AGENT_IDS, FakeHostedProvider, IMPORT_LIMITS, type LiveEvent, type ProviderDefect, human, seedInternalChannel,
} from '../../../apps/internal/src/composition/fixtures/make-external-provider';
import { composeMakeExternal } from '../../../apps/internal/src/composition/make-external';
import { openHistoryTransferLedger } from '../../../apps/internal/src/externalization/transfer-ledger';
import { fakeCapabilities, fakeEnvironment, fakeSources, fixtureLimits } from '../../conformance/subjects';
import { approvalFor, authoredEvent } from '../../conformance/suites';
import { ownerAuthority } from '../harness/owners';
import { type FakeHarnessAdapter, type ReferenceConnector, createFakeHarnessAdapter, createReferenceConnector } from '../harness/reference';
import { type ScenarioHarness, assertCleanClose, createScenarioHarness } from '../harness/scenario';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const HISTORY = [
  'kick-off: plan the release',
  '<script>alert("old")</script> please review',
  '@builder run the tests',
  'approve release r1',
  'done for today',
];

const owner = { ownerId: human.ownerId, participantId: human.participantId };
/** The two re-invited agents and the scenario owner fixture that plays each one. */
const AGENTS = [[AGENT_IDS[0], 'builder'], [AGENT_IDS[1], 'reviewer']] as const;

type Member = Readonly<{ seed: string; adapter: FakeHarnessAdapter; connector: ReferenceConnector }>;

type Run = Readonly<{
  scenario: ScenarioHarness;
  provider: FakeHostedProvider;
  members: ReadonlyMap<string, Member>;
  view: MakeExternalJourneyView;
  channelMessages: number;
}>;

/** Converts with carry history over a provider that loses the create response and one acknowledgement per part. */
async function convert(defect: ProviderDefect | null): Promise<Run> {
  const scenario = await createScenarioHarness({
    runId: `make-external-${defect ?? 'honest'}`, mode: 'fake-contract', owners: fakeEnvironment(['builder', 'reviewer', 'author']).owners,
    sources: fakeSources,
  });
  const root = fs.mkdtempSync('/tmp/khala-e2e-make-external-');
  const channel = seedInternalChannel({ root, messages: HISTORY });
  const ledgerDir = path.join(root, 'ledger');
  fs.mkdirSync(ledgerDir, { mode: 0o700 });
  const ledger = openHistoryTransferLedger(ledgerDir);
  cleanups.push(async () => {
    ledger.close();
    channel.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const provider = new FakeHostedProvider();
  provider.defect = defect;
  provider.loseCreateResponses = 1;
  const lost = new Set<string>();
  provider.loseAck = txn => !lost.has(txn) && Boolean(lost.add(txn));

  // Each agent's connector and fake session hears the destination once its binding is released.
  const members = new Map<string, Member>();
  for (const [participantId, seed] of AGENTS) {
    const fixture = scenario.owner(seed);
    const adapter = createFakeHarnessAdapter({ scenario, owner: fixture, capabilities: fakeCapabilities('queue') });
    members.set(participantId, { seed, adapter, connector: createReferenceConnector({ scenario, owner: fixture, adapter, limits: fixtureLimits }) });
  }
  const heard = new Map<string, Set<LiveEvent>>();
  const author = scenario.owner('author');
  const hear = async (participantId: string, event: LiveEvent) => {
    const seen = heard.get(participantId) ?? new Set();
    heard.set(participantId, seen);
    if (seen.has(event) || !provider.canExchange(participantId)) return;
    seen.add(event);
    const { ref, payload } = authoredEvent(author, event.roomId, `${event.origin}-${seen.size}`);
    await members.get(participantId)!.connector.deliver(ref, payload);
  };
  const syncAll = async () => {
    for (const participantId of members.keys()) for (const event of provider.live) await hear(participantId, event);
  };
  provider.onLive(() => void syncAll());

  const { journey } = composeMakeExternal({
    handle: channel.handle, hosted: provider, sessions: provider, access: provider, bindings: provider, signIn: provider,
    destinationUrl: provider.destinationUrl,
    history: { transport: provider, ledger, limits: IMPORT_LIMITS, ceiling: { maxDrainChunks: 64, drainDeadlineMs: 60_000 }, now: Date.now },
  });
  let operation = 0;
  const act = async (action: Record<string, unknown>) => {
    const result = await journey.act(owner, channel.channelId, { operationId: `op-${++operation}`, ...action } as MakeExternalAction);
    if (result.kind !== 'ok') throw new Error(`journey: ${JSON.stringify(result)}`);
    return result.view;
  };

  await act({ kind: 'sign_in' });
  let view = await act({ kind: 'start', historyMode: 'carry_history', visibility: 'secret', agents: AGENTS.map(([id]) => id) });
  for (let attempt = 0; attempt < 10 && view.conversion!.state !== 'agents_pending'; attempt += 1) view = await act({ kind: 'resume' });
  expect(view.conversion!.state).toBe('agents_pending');
  const handles = view.conversion!.agents.map(agent => agent.requestHandle!);
  await act({ kind: 'grant', requestHandles: handles });
  view = await act({ kind: 'resume' });
  view = await act({ kind: 'commit' });
  expect(view.conversion!.state).toBe('externalized');

  // Released members sync the destination timeline, then one new message arrives in it.
  await syncAll();
  provider.sendLive(view.conversion!.destinationChannelId!, 'first external message');
  await syncAll();

  // Each owner approves everything their connector holds, as a human reviewing the inbox would.
  for (const member of members.values()) {
    const fixture = scenario.owner(member.seed);
    const pending: readonly EventRef[] = [...member.connector.pending()];
    for (const [index, ref] of pending.entries()) {
      await member.connector.approve(
        ownerAuthority(fixture, { authorizationId: `authz-${member.seed}`, authenticatedAt: '2026-09-26T00:00:00Z' }),
        approvalFor(fixture, [ref], `approve-${member.seed}-${index}`, fixtureLimits),
      );
      member.adapter.settle();
    }
  }
  return { scenario, provider, members, view, channelMessages: channel.count() };
}

/** The contract's oracle: imported history wakes no agent and produces no receipt; only the new message does. */
function assertImportStaysInert(run: Run): void {
  for (const [participantId, member] of run.members) {
    expect(member.adapter.modelInputs(), `${participantId} model inputs`).toHaveLength(1);
    const pendingEvidence = run.scenario.evidence().filter(record => record.kind === 'event.pending' && record.ownerId === run.scenario.owner(member.seed).ownerId);
    expect(pendingEvidence, `${participantId} was woken only by the new message`).toHaveLength(1);
  }
  const receipts = run.scenario.evidence().filter(record => record.kind.startsWith('receipt.'));
  const releases = new Set([...run.members.values()].flatMap(member => member.connector.releases().map(release => release.releaseId)));
  expect(releases.size).toBe(run.members.size);
  expect(receipts.every(receipt => releases.has(receipt.operationId))).toBe(true);
  expect(run.provider.live.filter(event => event.origin === 'imported')).toEqual([]);
}

describe('make external over a lossy fake provider', () => {
  it('yields one external channel and one verified import, and imported history wakes no agent', async () => {
    const run = await convert(null);
    const conversion = run.view.conversion!;
    expect(run.provider.creates).toHaveLength(1);
    expect(conversion.history!.chunkCount).toBeGreaterThan(1);
    expect(run.provider.parts.size).toBe(conversion.history!.chunkCount + 1);
    const archive = await openImportedArchive(run.provider, {
      roomId: conversion.destinationChannelId as RoomId, archiveId: `history.${conversion.conversionId}`,
      manifestDigest: conversion.history!.manifestDigest!, limits: IMPORT_LIMITS,
    });
    expect(archive.ok && archive.view.records.map(record => record.body)).toEqual(HISTORY);
    expect(run.channelMessages).toBe(HISTORY.length);

    assertImportStaysInert(run);
    const report = await run.scenario.close();
    assertCleanClose(report);
  });

  it('catches the wrong implementation that replays imported history as live events', async () => {
    const run = await convert('imported_as_live');
    expect(() => assertImportStaysInert(run)).toThrow();
    expect(Math.max(...[...run.members.values()].map(member => member.adapter.modelInputs().length))).toBeGreaterThan(1);
    await run.scenario.close();
  });
});
