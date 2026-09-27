// Acceptance 1, listening modes and pause, over the real launcher. `khala internal`
// starts the launcher, loopback server and SQLite store; an externally started Codex
// session discovers, joins and is granted exactly as in the protocol lane; the test
// acts as the human through the owner API, which sets the binding's mode and pauses
// it. The fake is only the Codex TUI: it fires its native hook events at the exact
// installed command, `khala codex-hook` with no option, and states the released
// capability claim of its installed version and hook trust, which the production
// entry reads from the installed Codex instead.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DeliveryLimits, type HarnessCapabilities, type ListeningMode, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import { initialListeningModeControl, listeningModeView } from '@khala/policy/listening-mode/store';
import { MAX_SEND_BYTES } from '../../../packages/agent-cli/src/cli/send';
import { controlsFor } from '../../conformance/subjects';
import {
  type HumanSession, type KhalaProfile, type ProcessAudit, freePort, humanSession, installProcessAudit, startLauncher,
} from '../harness/internal';
import { type ScenarioHarness, assertCleanClose, createScenarioHarness } from '../harness/scenario';
import { type ExternalCli, type ReadView, createExternalCli, parseBatch } from './cli-driver';

const CODEX_VERSION = '0.156.1';
const SESSION = 'session-codex';
const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: MAX_SEND_BYTES });
if (!decodedLimits.ok) throw new Error('limits');
const limits: DeliveryLimits = decodedLimits.value;

/** The released claim for a trusted, receipt-proven Codex TUI hook route. */
const PROVEN = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'trusted' }, { proven: true, route: 'hook', version: CODEX_VERSION });
/** The same TUI with no receipt proof: every mode but `async` is proven. */
const NO_RECEIPT = interactiveCodexCapabilities(CODEX_VERSION, limits, { state: 'trusted' });

type Hook = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';
type HookOutput = Readonly<{ delivery: 'none' } | { delivery: 'block' | 'context'; batch: ReadView }>;

type Lane = Readonly<{
  scenario: ScenarioHarness;
  human: HumanSession;
  agent: ExternalCli;
  /** The Codex TUI's released claim, which the hook projects the server-held mode through. */
  claim: { value: HarnessCapabilities };
  /** The owner sets the binding's mode through the owner API. */
  setMode(mode: ListeningMode): Promise<void>;
  /** The owner pauses or resumes the binding through the owner API. */
  pause(paused: boolean): Promise<void>;
  hook(event: Hook, turn: string, stopHookActive?: boolean): Promise<HookOutput>;
  read(ack?: string): Promise<ReadView>;
  releases(): Promise<{ held: string | null; releases: { wake: boolean }[] }>;
  say(body: string): Promise<string>;
}>;

let audit: ProcessAudit | null = null;
let open: ScenarioHarness | null = null;
afterEach(async () => {
  const scenario = open;
  open = null;
  try {
    if (scenario) assertCleanClose(await scenario.close());
  } finally {
    audit?.uninstall();
    audit = null;
  }
});

async function lane(): Promise<Lane> {
  audit = installProcessAudit();
  const scenario = await createScenarioHarness({
    runId: 'internal-mode-listening',
    mode: 'fake-contract',
    owners: [{ seed: 'h', controls: controlsFor('h', 'none') }, { seed: 'a', controls: controlsFor('a', 'codex') }],
    sources: [{ component: 'khala-internal', version: '0.0.0' }, { component: 'codex', version: CODEX_VERSION }],
  });
  open = scenario;
  const agentOwner = scenario.owner('a').ownerId;
  const stateHome = scenario.stateDir(scenario.owner('h').ownerId);
  const launcherProfile: KhalaProfile = { stateHome, stateDirectory: path.join(stateHome, 'khala'), port: await freePort() };
  // The user starts their Codex TUI before Khala is asked for anything.
  const agent = createExternalCli({
    name: 'cli-codex', harness: 'codex', sessionId: SESSION, ownerId: agentOwner,
    stateDirectory: scenario.stateDir(agentOwner), audit,
    record: (kind, subject) => { scenario.record(kind, subject); },
  });
  scenario.defer('user-cli:codex', agentOwner, () => agent.close());
  const launcher = await startLauncher(launcherProfile);
  scenario.defer(`launcher:${launcher.report.channelId}`, scenario.owner('h').ownerId, async () => { await launcher.close(); });
  const human = await humanSession(launcher.report);

  // Discover, request, approve, connect: the same grant flow as the protocol lane.
  const channelUrl = `${human.origin}/channels/${human.channelId}`;
  await agent.discover(launcherProfile);
  expect(await agent.join(channelUrl)).toBe('pending_owner');
  const inbox = await human.call('/api/human/channel-requests');
  const [request] = (inbox.json as { requests: { requestHandle: string; revision: string }[] }).requests;
  expect((await human.call(`/api/human/channel-access-requests/${request!.requestHandle}/decision`, {
    method: 'POST',
    body: { v: 1, requestHandle: request!.requestHandle, expectedRevision: request!.revision, decision: 'approve', operationId: 'decide-codex' },
  })).status).toBe(200);
  expect(await agent.join(channelUrl)).toBe('connected');
  const { binding } = await agent.status();
  const bindingPath = `/api/v1/channels/${human.channelId}/bindings/${binding!.bindingId}`;

  const claim = { value: PROVEN };
  let commands = 0;
  let messages = 0;
  const result: Lane = {
    scenario, human, agent, claim,
    async setMode(mode) {
      const current = await human.call(`${bindingPath}/listening-mode`);
      expect(current.status).toBe(200);
      const { view } = current.json as { view: { version: number } };
      const set = await human.call(`${bindingPath}/listening-mode`, {
        method: 'POST',
        body: { v: 1, commandId: `owner-mode-${++commands}`, generation: binding!.generation, expectedVersion: view.version, requested: mode, issuedAt: new Date().toISOString() },
      });
      expect(set.json).toMatchObject({ outcome: 'applied', requested: mode });
    },
    async pause(paused) {
      const reply = await human.call(`${bindingPath}/pause`, { method: 'POST', body: { v: 1, generation: binding!.generation, paused } });
      expect(reply.json).toMatchObject({ paused });
    },
    async hook(event, turn, stopHookActive = false) {
      const run = await agent.codexHook({
        hook_event_name: event, session_id: SESSION, turn_id: turn,
        ...(event === 'Stop' ? { stop_hook_active: stopHookActive } : {}),
      }, async () => claim.value);
      expect(run.code).toBe(0);
      // A suppressed hook reports a content-free code; none is expected on any path here.
      expect(run.stderr).toBe('');
      if (run.stdout === '') return { delivery: 'none' };
      const parsed = JSON.parse(run.stdout) as { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext: string } };
      const text = parsed.decision === 'block' ? parsed.reason! : parsed.hookSpecificOutput!.additionalContext;
      const batch = parseBatch(text.slice(text.indexOf('<khala-channel-batch-v1>')));
      if (batch.kind === 'batch') {
        for (const release of batch.events) scenario.record('context.consumed', { ownerId: agentOwner, operationId: `event-${release.eventId}` });
      }
      return { delivery: parsed.decision === 'block' ? 'block' : 'context', batch };
    },
    read: ack => agent.read(ack),
    async releases() {
      const { bindingCapability } = JSON.parse(fs.readFileSync(agent.descriptorPath(), 'utf8')) as { bindingCapability: string };
      const response = await fetch(`${human.origin}/api/v1/channels/${human.channelId}/releases?limit=50`, {
        headers: { authorization: `Bearer ${bindingCapability}` },
      });
      expect(response.status).toBe(200);
      return await response.json() as { held: string | null; releases: { wake: boolean }[] };
    },
    async say(body) {
      const reply = await human.call(`/api/v1/channels/${human.channelId}/messages`, {
        method: 'POST', body: { clientTxnId: `txn-mode-${String(++messages).padStart(4, '0')}`, content: { v: 1, kind: 'text', body } },
      });
      expect(reply.status).toBe(201);
      return (reply.json as { event: { eventId: string } }).event.eventId;
    },
  };
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
    const control = initialListeningModeControl({ bindingId: 'binding-x' as never, generation: 1 }, PROVEN);
    for (const mode of ['steer', 'sync', 'async'] as const) {
      expect(listeningModeView({ ...control, requested: mode }, PROVEN).effective).toBe(mode);
    }
    // Without a receipt proof async is not offered; without trusted hooks, or on an unproven version, nothing is.
    expect(listeningModeView({ ...control, requested: 'async' }, NO_RECEIPT)).toMatchObject({ effective: null, effectiveReason: 'support_unknown' });
    expect(NO_RECEIPT.modes.async.reason).toMatch(/Awaiting a receipt proof/);
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
    await l.setMode('steer');
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
    // `sync` is the binding's starting mode; the owner never had to set it.
    const queued = await l.say('tell me when you are done');
    expect(await l.hook('PreToolUse', 'turn-1')).toEqual({ delivery: 'none' });
    expect(await l.hook('PostToolUse', 'turn-1')).toEqual({ delivery: 'none' });
    const end = await l.hook('Stop', 'turn-1');
    expect(end.delivery).toBe('block');
    expect(eventsOf(end)).toEqual([queued]);
    // The continuation turn's Stop never pulls again, which bounds the loop to one.
    expect(await l.hook('Stop', 'turn-1', true)).toEqual({ delivery: 'none' });
    expect(await l.read(tokenOf(end))).toEqual({ kind: 'empty' });
  });

  it('async: no hook injects anything and the message arrives only through khala read', async () => {
    const l = await lane();
    await l.setMode('async');
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
    await l.setMode('async');
    l.claim.value = NO_RECEIPT;
    expect(await l.agent.mode(['get'], async () => l.claim.value)).toMatchObject({
      ok: true, kind: 'view', requested: 'async', effective: null, effectiveReason: 'support_unknown',
      support: { async: { status: 'unknown' }, sync: { status: 'proven' } },
    });
    await l.say('not through a hook');
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop'] as const) {
      expect(await l.hook(event, 'turn-1')).toEqual({ delivery: 'none' });
    }
  });

  it('the agent reads and sets its own binding mode through khala mode; the owner sees who changed it', async () => {
    const l = await lane();
    const claim = async () => l.claim.value;
    const view = await l.agent.mode(['get'], claim);
    expect(view).toMatchObject({ ok: true, kind: 'view', requested: 'sync', effective: 'sync', version: 1 });
    expect(await l.agent.mode(['set', 'steer', '--expected-version', '1'], claim))
      .toMatchObject({ ok: true, kind: 'applied', requested: 'steer', effective: 'steer', version: 2 });
    // A stale version conflicts and reports the current record.
    expect(await l.agent.mode(['set', 'async', '--expected-version', '1'], claim))
      .toMatchObject({ ok: false, kind: 'conflict', current: { requested: 'steer', version: 2 } });
    const seen = await l.human.call(`/api/v1/channels/${l.human.channelId}/bindings/${(await l.agent.status()).binding!.bindingId}/listening-mode`);
    expect((seen.json as { view: unknown }).view).toMatchObject({ requested: 'steer', version: 2, lastChangedBy: { kind: 'agent' } });
  });

  it('the owner sees a supported mode only after the agent\'s CLI reports a proven, trusted Codex', async () => {
    const l = await lane();
    const owned = async () => {
      const listed = await l.human.call(`/api/v1/channels/${l.human.channelId}/bindings`);
      expect(listed.status).toBe(200);
      return (listed.json as { bindings: { view: { requested: string; effective: string | null; support: Record<string, { status: string }> } }[] }).bindings[0]!.view;
    };
    // Before any report the server knows nothing about the harness, so it claims nothing.
    expect(await owned()).toMatchObject({ requested: 'sync', effective: null, effectiveReason: 'capabilities_unavailable' });
    const input = { hook_event_name: 'PreToolUse', session_id: SESSION, turn_id: 'turn-1' };
    expect((await l.agent.codexHook(input, async () => l.claim.value, async () => ({ version: CODEX_VERSION, hookReview: 'trusted' }))).code).toBe(0);
    // The released claim for that observation proves steer and sync; with no shipped receipt proof, async stays unproven.
    expect(await owned()).toMatchObject({
      effective: 'sync', support: { steer: { status: 'proven' }, sync: { status: 'proven' }, async: { status: 'unknown' } },
    });
    await l.agent.codexHook(input, async () => l.claim.value, async () => ({ version: CODEX_VERSION, hookReview: 'awaiting_hook_review' }));
    expect(await owned()).toMatchObject({ effective: null, effectiveReason: 'support_unknown' });
  });

  it('pause holds the release before any claim; resume delivers it exactly once', async () => {
    const l = await lane();
    await l.pause(true);
    const held = await l.say('held while paused');
    expect(await l.releases()).toMatchObject({ held: 'paused', releases: [] });
    // Nothing is claimed: no hook boundary and no explicit read sees it.
    expect(await l.hook('UserPromptSubmit', 'turn-1')).toEqual({ delivery: 'none' });
    expect(await l.hook('Stop', 'turn-1')).toEqual({ delivery: 'none' });
    expect(await l.read()).toEqual({ kind: 'empty' });

    await l.pause(false);
    const resumed = await l.hook('UserPromptSubmit', 'turn-2');
    expect(resumed.delivery).toBe('context');
    expect(eventsOf(resumed)).toEqual([held]);
    expect(await l.read(tokenOf(resumed))).toEqual({ kind: 'empty' });
    expect(await l.hook('Stop', 'turn-2')).toEqual({ delivery: 'none' });
    expect(l.scenario.evidence().filter(record => record.kind === 'context.consumed')).toHaveLength(1);
  });

  // Wrong-implementation test: a hook that assumed the default mode instead of reading the
  // binding's server-held record, or trusted the server's own projection instead of the
  // local harness claim, would block at this Stop. Only the owner's change back to `sync`
  // makes the same boundary deliver.
  it('wrong implementation: the owner\'s async choice silences a proven sync boundary until the owner changes it', async () => {
    const l = await lane();
    await l.setMode('async');
    const queued = await l.say('owner chose async');
    expect(await l.hook('Stop', 'turn-1')).toEqual({ delivery: 'none' });
    await l.setMode('sync');
    const end = await l.hook('Stop', 'turn-2');
    expect(end.delivery).toBe('block');
    expect(eventsOf(end)).toEqual([queued]);
    expect(await l.read(tokenOf(end))).toEqual({ kind: 'empty' });
    // With no harness claim at all the same boundary is silent: nothing is ever claimed by default.
    const again = await l.say('no claim, no delivery');
    const silent = await l.agent.codexHook({ hook_event_name: 'Stop', session_id: SESSION, turn_id: 'turn-3', stop_hook_active: false });
    expect(silent.stdout).toBe('');
    const pulled = await l.read();
    expect(pulled.kind === 'batch' && pulled.events.map(event => event.eventId)).toEqual([again]);
    // Khala started no process of any kind for the agent.
    expect(audit!.started()).toEqual([]);
  });
});
