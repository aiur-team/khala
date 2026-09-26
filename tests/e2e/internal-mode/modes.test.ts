// Acceptance 1, listening modes and pause. The internal launcher composes neither
// yet: it passes no pause source to the release feed, serves no mode control, and
// its local client has no `listeningMode()`, so `khala codex-hook` stays silent in
// internal mode (#392). Until that lands, this lane composes the same internal
// pieces directly — the loopback server, the SQLite channel store, the release
// feed with a pause source, the SQLite listening-mode store — and supplies the
// hook's mode status from that store through the released capability projection.
// The fake is only the Codex TUI firing its native hook events at `khala codex-hook`.

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { type DeliveryLimits, type HarnessCapabilities, type ListeningMode, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { encodeInternalDescriptor } from '@khala/contracts/internal/descriptor';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import { initialListeningModeControl, listeningModeView } from '@khala/policy/listening-mode/store';
import { createInternalReleaseFeed } from '../../../apps/internal/src/composition/internal-delivery/release-feed';
import { createSqliteListeningModeRepository } from '../../../apps/internal/src/listening-mode-store/sqlite';
import { startChannelServer } from '../../../apps/internal/src/server/channel-server';
import { mintCredential } from '../../../apps/internal/src/server/credentials';
import { bobBinding, channelId, createChannelFixture } from '../../../apps/internal/src/server/fixtures/channel-fixture';
import { runCli } from '../../../packages/agent-cli/src/cli/app';
import { openInbox } from '../../../packages/agent-cli/src/cli/inbox';
import { MAX_SEND_BYTES } from '../../../packages/agent-cli/src/cli/send';
import { deliveringInbox } from '../../../packages/agent-cli/src/composition/delivering-inbox';
import { createInternalClient } from '../../../packages/agent-cli/src/composition/internal';
import { createInternalDelivery } from '../../../packages/agent-cli/src/composition/internal-delivery';
import { controlsFor } from '../../conformance/subjects';
import { type HumanSession, humanSession, khalaOnce } from '../harness/internal';
import { type ScenarioHarness, assertCleanClose, createScenarioHarness } from '../harness/scenario';
import { type ReadView, parseBatch } from './cli-driver';

const CODEX_VERSION = '0.156.1';
const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: MAX_SEND_BYTES });
if (!decodedLimits.ok) throw new Error('limits');
const limits: DeliveryLimits = decodedLimits.value;

/** The released claim for a trusted, receipt-proven Codex TUI hook route. */
const PROVEN = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'trusted' }, { proven: true, route: 'hook', version: CODEX_VERSION });

type Hook = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';
type HookOutput = Readonly<{ delivery: 'none' } | { delivery: 'block' | 'context'; batch: ReadView }>;

type Lane = Readonly<{
  scenario: ScenarioHarness;
  human: HumanSession;
  pause: { value: boolean };
  /** Owner-side mode change through the SQLite listening-mode store, as the mode control would write it. */
  setMode(mode: ListeningMode): void;
  /** The mode status the Codex hook sees for the bound session. */
  capabilities: { value: HarnessCapabilities };
  hook(event: Hook, turn: string, stopHookActive?: boolean): Promise<HookOutput>;
  read(ack?: string): Promise<ReadView>;
  releases(): Promise<{ held: string | null; releases: { wake: boolean }[] }>;
  say(body: string): Promise<string>;
}>;

let active: Lane | null = null;
afterEach(async () => {
  if (active) assertCleanClose(await active.scenario.close());
  active = null;
});

async function lane(): Promise<Lane> {
  const scenario = await createScenarioHarness({
    runId: 'internal-mode-listening',
    mode: 'fake-contract',
    owners: [{ seed: 'h', controls: controlsFor('h', 'none') }, { seed: 'a', controls: controlsFor('a', 'codex') }],
    sources: [{ component: 'khala-internal', version: '0.0.0' }, { component: 'codex', version: CODEX_VERSION }],
  });
  const agentOwner = scenario.owner('a').ownerId;
  const serverRoot = path.join(scenario.stateDir(scenario.owner('h').ownerId), 'server');
  fs.mkdirSync(serverRoot, { mode: 0o700 });
  const now = Date.now();
  const fixture = createChannelFixture({ root: serverRoot, now });
  scenario.defer('channel-store', null, async () => fixture.dispose());
  const modes = createSqliteListeningModeRepository(fixture.handle);
  const key = { bindingId: bobBinding.bindingId, generation: bobBinding.generation };
  expect(modes.initialize(initialListeningModeControl(bobBinding, PROVEN))).toBe(true);
  const pause = { value: false };
  let id = 0;
  const server = await startChannelServer({
    store: fixture.store,
    bootstrap: [fixture.bootstrap],
    bindings: [fixture.bob],
    releases: createInternalReleaseFeed({ store: fixture.store, listeningModes: modes, paused: () => pause.value }),
    newId: () => `mode-${++id}`,
    clock: Date.now,
    startPort: 0,
  });
  scenario.defer('server', null, () => server.close());
  const human = await humanSession({
    channelId, origin: server.origin, port: server.port, resumeCommand: '', descriptorPath: '',
    url: `${server.origin}/__khala/bootstrap#credential=${fixture.bootstrap.credential}&channel=${channelId}`,
  });

  // The Codex session's own Khala state and granted descriptor.
  const agentState = path.join(scenario.stateDir(agentOwner), 'khala');
  fs.mkdirSync(agentState, { mode: 0o700 });
  const descriptorPath = path.join(agentState, 'active.json');
  fs.writeFileSync(descriptorPath, encodeInternalDescriptor({
    v: 1, channelId, origin: server.origin, transportCapability: mintCredential(),
    grantRef: 'grant-codex', bindingId: bobBinding.bindingId, bindingCapability: fixture.bob.credential,
  }), { mode: 0o600 });
  const profile = { stateHome: scenario.stateDir(agentOwner), stateDirectory: agentState, port: 0 };
  const open = (bindingId: string, generation: number) => openInbox({
    stateDirectory: agentState, bindingId, generation, maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
  });
  const capabilities = { value: PROVEN };
  let messages = 0;
  let version = 1;

  const result: Lane = {
    scenario, human, pause, capabilities,
    setMode(mode) {
      const current = modes.read(key);
      if (current.kind !== 'record') throw new Error('mode record missing');
      const written = modes.compareAndSet({
        key, expectedVersion: current.control.version, operationId: `owner-mode-${++version}`,
        operationFingerprint: JSON.stringify([key, mode, version]),
        next: { ...current.control, requested: mode, lastChangedBy: { kind: 'owner', participantId: fixture.bootstrap.human.participantId } },
      });
      expect(written.kind).toBe('applied');
    },
    async hook(event, turn, stopHookActive = false) {
      const client = createInternalClient({ descriptorPath });
      const control = modes.read(key);
      if (control.kind !== 'record') throw new Error('mode record missing');
      const view = listeningModeView(control.control, capabilities.value);
      const delivering = deliveringInbox(open, createInternalDelivery({ descriptorPath, stateDirectory: agentState }));
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = '';
      stdout.on('data', chunk => { out += String(chunk); });
      const stdin = new PassThrough();
      stdin.end(JSON.stringify({
        hook_event_name: event, session_id: bobBinding.sessionId, turn_id: turn,
        ...(event === 'Stop' ? { stop_hook_active: stopHookActive } : {}),
      }));
      try {
        const code = await runCli(['codex-hook'], {
          client: {
            ...client,
            listeningMode: async () => ({ v: 1, bindingId: bobBinding.bindingId, generation: bobBinding.generation, effective: view.effective }),
          },
          inbox: delivering.inbox, stdin, stdout, stderr,
        });
        expect(code).toBe(0);
      } finally {
        await delivering.stop();
      }
      if (out === '') return { delivery: 'none' };
      const parsed = JSON.parse(out) as { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext: string } };
      const text = parsed.decision === 'block' ? parsed.reason! : parsed.hookSpecificOutput!.additionalContext;
      const frame = text.slice(text.indexOf('<khala-channel-batch-v1>'));
      const batch = parseBatch(frame);
      if (batch.kind === 'batch') for (const release of batch.events) scenario.record('context.consumed', { ownerId: agentOwner, operationId: `event-${release.eventId}` });
      return { delivery: parsed.decision === 'block' ? 'block' : 'context', batch };
    },
    async read(ack) {
      const run = await khalaOnce(profile, ['--internal-descriptor', descriptorPath, 'read', ...(ack === undefined ? [] : ['--ack', ack])]);
      expect(run.code).toBe(0);
      const text = run.stdout.trim();
      return text.startsWith('{') ? { kind: 'empty' } : parseBatch(text);
    },
    async releases() {
      const response = await fetch(`${server.origin}/api/v1/channels/${channelId}/releases?limit=50`, {
        headers: { authorization: `Bearer ${fixture.bob.credential}` },
      });
      expect(response.status).toBe(200);
      return await response.json() as { held: string | null; releases: { wake: boolean }[] };
    },
    async say(body) {
      const reply = await human.call(`/api/v1/channels/${channelId}/messages`, {
        method: 'POST', body: { clientTxnId: `txn-mode-${String(++messages).padStart(4, '0')}`, content: { v: 1, kind: 'text', body } },
      });
      expect(reply.status).toBe(201);
      return (reply.json as { event: { eventId: string } }).event.eventId;
    },
  };
  active = result;
  return result;
}

function eventsOf(output: HookOutput): readonly string[] {
  if (output.delivery === 'none' || output.batch.kind !== 'batch') return [];
  return output.batch.events.map(event => event.eventId);
}

function tokenOf(output: HookOutput | ReadView): string {
  const view = 'delivery' in output ? (output.delivery === 'none' ? null : output.batch) : output;
  if (view?.kind !== 'batch') throw new Error('no batch');
  return view.token;
}

describe('internal listening modes and pause', () => {
  it('offers only proven modes and keeps unproven ones disabled with a reason', () => {
    const control = initialListeningModeControl(bobBinding, PROVEN);
    for (const mode of ['steer', 'sync', 'async'] as const) {
      expect(listeningModeView({ ...control, requested: mode }, PROVEN).effective).toBe(mode);
    }
    // Without a receipt proof async is not offered; without trusted hooks, or on an unproven version, nothing is.
    const noReceipt = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'trusted' });
    expect(listeningModeView({ ...control, requested: 'async' }, noReceipt)).toMatchObject({ effective: null, effectiveReason: 'support_unknown' });
    expect(noReceipt.modes.async.reason).toMatch(/Awaiting a receipt proof/);
    const untrusted = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'awaiting_hook_review', reason: 'Review the hooks.' });
    const unproven = interactiveCodexCapabilities('0.1.0', limits, { state: 'trusted' });
    for (const claim of [untrusted, unproven]) {
      for (const mode of ['steer', 'sync', 'async'] as const) {
        expect(listeningModeView({ ...control, requested: mode }, claim)).toMatchObject({ effective: null, effectiveReason: 'support_unknown' });
        expect(claim.modes[mode].reason).toMatch(/Idle agents receive messages only at their next turn/);
      }
    }
  });

  it('steer: a message queued during a long tool waits for the tool to finish, then arrives at the next boundary', async () => {
    const l = await lane();
    l.setMode('steer');
    // The tool starts with nothing queued, so it runs.
    expect(await l.hook('PreToolUse', 'turn-1')).toEqual({ delivery: 'none' });
    const queued = await l.say('steer me after this tool');
    // The long tool completes; only then is the queued message added, without aborting anything.
    const after = await l.hook('PostToolUse', 'turn-1');
    expect(after.delivery).toBe('context');
    expect(eventsOf(after)).toEqual([queued]);
    // Acknowledged on the next Khala call; nothing is offered again.
    expect(await l.read(tokenOf(after))).toEqual({ kind: 'empty' });
    expect(await l.hook('Stop', 'turn-1')).toEqual({ delivery: 'none' });
  });

  it('sync: tool boundaries stay silent and the message arrives at the end of the turn', async () => {
    const l = await lane();
    l.setMode('sync');
    expect(await l.hook('PreToolUse', 'turn-1')).toEqual({ delivery: 'none' });
    const queued = await l.say('tell me when you are done');
    expect(await l.hook('PostToolUse', 'turn-1')).toEqual({ delivery: 'none' });
    expect(await l.hook('PreToolUse', 'turn-1')).toEqual({ delivery: 'none' });
    const end = await l.hook('Stop', 'turn-1');
    expect(end.delivery).toBe('block');
    expect(eventsOf(end)).toEqual([queued]);
    // The continuation turn's Stop never pulls again, which bounds the loop to one.
    expect(await l.hook('Stop', 'turn-1', true)).toEqual({ delivery: 'none' });
    expect(await l.read(tokenOf(end))).toEqual({ kind: 'empty' });
  });

  it('async: no hook injects anything and the message arrives only through khala read', async () => {
    const l = await lane();
    l.setMode('async');
    const queued = await l.say('read me when you like');
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const) {
      expect(await l.hook(event, 'turn-1')).toEqual({ delivery: 'none' });
    }
    // The server never marks an async release as a wake.
    expect((await l.releases()).releases.map(release => release.wake)).toEqual([false]);
    const pulled = await l.read();
    expect(pulled.kind === 'batch' && pulled.events.map(event => event.eventId)).toEqual([queued]);
    expect(await l.read(tokenOf(pulled))).toEqual({ kind: 'empty' });
  });

  it('an unproven async route delivers nothing through hooks and never claims the mode', async () => {
    const l = await lane();
    l.setMode('async');
    l.capabilities.value = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'trusted' });
    await l.say('not through a hook');
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop'] as const) {
      expect(await l.hook(event, 'turn-1')).toEqual({ delivery: 'none' });
    }
  });

  it('pause holds the release before any claim; resume delivers it exactly once', async () => {
    const l = await lane();
    l.setMode('sync');
    l.pause.value = true;
    const held = await l.say('held while paused');
    expect(await l.releases()).toMatchObject({ held: 'paused', releases: [] });
    // Nothing is claimed: no hook boundary and no explicit read sees it.
    expect(await l.hook('UserPromptSubmit', 'turn-1')).toEqual({ delivery: 'none' });
    expect(await l.hook('Stop', 'turn-1')).toEqual({ delivery: 'none' });
    expect(await l.read()).toEqual({ kind: 'empty' });

    l.pause.value = false;
    const resumed = await l.hook('UserPromptSubmit', 'turn-2');
    expect(resumed.delivery).toBe('context');
    expect(eventsOf(resumed)).toEqual([held]);
    expect(await l.read(tokenOf(resumed))).toEqual({ kind: 'empty' });
    expect(await l.hook('Stop', 'turn-2')).toEqual({ delivery: 'none' });
    expect(l.scenario.evidence().filter(record => record.kind === 'context.consumed')).toHaveLength(1);
  });
});
