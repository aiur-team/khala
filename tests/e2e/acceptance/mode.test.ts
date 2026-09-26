// The runner's `requestMode` against the real internal launcher's owner mode route
// (#392, #399). An externally started Codex session joins and is granted; the runner's
// owner session then requests each mode and reports `effective` only when the server
// confirms it for that exact binding generation. Wrong-implementation test: an adapter
// that still reported every mode unsupported, or that assumed a mode effective without
// the server confirming it, fails here.

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerSessionFor } from '../../../scripts/acceptance/adapters/launcher';
import type { OwnerSession, StopTarget } from '../../../scripts/acceptance/types';
import { controlsFor } from '../../conformance/subjects';
import { type ProcessAudit, freePort, installProcessAudit, startLauncher } from '../harness/internal';
import { type ScenarioHarness, assertCleanClose, createScenarioHarness } from '../harness/scenario';
import { type ExternalCli, createExternalCli } from '../internal-mode/cli-driver';

const CODEX_VERSION = '0.156.1';
const SESSION = 'session-codex';

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

type Bound = Readonly<{ owner: OwnerSession; agent: ExternalCli; target: StopTarget; modeOf(): Promise<Record<string, unknown>> }>;

async function bound(): Promise<Bound> {
  audit = installProcessAudit();
  const scenario = await createScenarioHarness({
    runId: 'acceptance-runner-mode',
    mode: 'fake-contract',
    owners: [{ seed: 'h', controls: controlsFor('h', 'none') }, { seed: 'a', controls: controlsFor('a', 'codex') }],
    sources: [{ component: 'khala-internal', version: '0.0.0' }, { component: 'codex', version: CODEX_VERSION }],
  });
  open = scenario;
  const agentOwner = scenario.owner('a').ownerId;
  const stateHome = scenario.stateDir(scenario.owner('h').ownerId);
  const launcherProfile = { stateHome, stateDirectory: path.join(stateHome, 'khala'), port: await freePort() };
  const agent = createExternalCli({
    name: 'cli-codex', harness: 'codex', sessionId: SESSION, ownerId: agentOwner,
    stateDirectory: scenario.stateDir(agentOwner), audit,
    record: (kind, subject) => { scenario.record(kind, subject); },
  });
  scenario.defer('user-cli:codex', agentOwner, () => agent.close());
  const launcher = await startLauncher(launcherProfile);
  scenario.defer(`launcher:${launcher.report.channelId}`, scenario.owner('h').ownerId, async () => { await launcher.close(); });

  // The runner's own owner session drives the grant, as it does in a live run.
  const owner = await ownerSessionFor(launcher.report);
  await agent.discover(launcherProfile);
  expect(await agent.join(owner.channelUrl)).toBe('pending_owner');
  const [request] = await owner.accessRequests();
  await owner.approve(request!, 'decide-codex');
  expect(await agent.join(owner.channelUrl)).toBe('connected');
  const { binding } = await agent.status();
  // The mode route addresses the binding by id and generation; the participant is Stop's concern.
  const target = { bindingId: binding!.bindingId, generation: binding!.generation, agentParticipantId: 'participant_unused' };
  return {
    owner, agent, target,
    // The agent's own view of its server-held record, read independently of the owner's reply.
    modeOf: () => agent.mode(['get']),
  };
}

/** The agent's CLI reports a trusted Codex at a proven version, as its hook does on every call. */
async function reportTrustedCodex(agent: ExternalCli): Promise<void> {
  const run = await agent.codexHook(
    { hook_event_name: 'PreToolUse', session_id: SESSION, turn_id: 'turn-1' },
    undefined, async () => ({ version: CODEX_VERSION, hookReview: 'trusted' }),
  );
  expect(run.code).toBe(0);
}

describe('runner requestMode over the owner mode route', () => {
  it('confirms each mode the route proves and leaves the binding in the mode it reported', async () => {
    const { owner, agent, target, modeOf } = await bound();
    await reportTrustedCodex(agent);
    for (const mode of ['steer', 'sync', 'steer'] as const) {
      expect(await owner.requestMode(target, mode)).toEqual({ kind: 'effective' });
      expect(await modeOf()).toMatchObject({ ok: true, kind: 'view', requested: mode });
    }
  }, 60_000);

  it('keeps a mode the route does not prove unsupported, with the server\'s reason, instead of assuming it', async () => {
    const { owner, agent, target } = await bound();
    // Before the agent reports its harness the server claims nothing, so even the default is unproven.
    expect(await owner.requestMode(target, 'sync')).toEqual({ kind: 'unsupported', reason: 'sync is not effective: capabilities_unavailable' });
    await reportTrustedCodex(agent);
    // No shipped receipt proof: async stays unproven even on a trusted, proven Codex.
    const async = await owner.requestMode(target, 'async');
    expect(async.kind).toBe('unsupported');
    expect(await owner.requestMode(target, 'sync')).toEqual({ kind: 'effective' });
  }, 60_000);

  it('refuses a stale generation or unknown binding instead of reporting the mode effective', async () => {
    const { owner, agent, target } = await bound();
    await reportTrustedCodex(agent);
    expect(await owner.requestMode({ ...target, generation: target.generation + 1 }, 'steer'))
      .toEqual({ kind: 'unsupported', reason: 'the binding generation changed' });
    expect(await owner.requestMode({ ...target, bindingId: 'binding_never_issued' }, 'steer'))
      .toEqual({ kind: 'unsupported', reason: 'listening-mode read refused: 404' });
  }, 60_000);
});
