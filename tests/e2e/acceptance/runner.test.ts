// AC3 runner orchestration over offline ports (docs/product/internal-mode/acceptance.md,
// "AC3 — Live acceptance runner"). Each wrong implementation named by the contract
// is a scripted world that must not produce `pass`.

import { describe, expect, it } from 'vitest';
import { runAcceptance } from '../../../scripts/acceptance/runner';
import type { RunReport } from '../../../scripts/acceptance/types';
import { RUN_ID, UNPROVEN_ASYNC_CODEX, type World, createWorld, offlineProfile, profileInput } from './fakes';

async function run(world: World): Promise<RunReport> {
  return runAcceptance(world.deps, { profile: world.profile, runId: RUN_ID, resume: null });
}

function status(report: RunReport, name: string): string | undefined {
  return report.checks.find(entry => entry.check === name)?.status;
}

/** Launcher closed, tickets closed and the lock released: the `finally` obligations. */
function expectCleanTail(world: World, report: RunReport): void {
  expect(world.serverClosed()).toBe(true);
  expect(report.launcherClosed).toBe(true);
  expect(world.closed.sort()).toEqual([...world.issues.keys()].sort());
  expect(world.lockReleased()).toBe(true);
}

describe('live acceptance runner', () => {
  it('passes a pair that handshakes in every declared-supported mode, stops, closes and cleans up', async () => {
    const world = createWorld();
    const report = await run(world);
    expect(report.errors).toEqual([]);
    expect(report.checks.filter(entry => entry.status !== 'pass')).toEqual([]);
    expect(report.verdict).toBe('pass');
    expect(report.modes.runnable).toEqual(['steer', 'sync', 'async']);
    // Every declared-supported mode is requested for both bindings through the mode route.
    expect(world.modeCalls).toEqual(['steer', 'sync', 'async'].flatMap(mode => [
      { bindingId: 'binding_a', mode }, { bindingId: 'binding_b', mode },
    ]));
    expect(world.issues.size).toBe(2);
    for (const issue of world.issues.values()) expect(issue.labels).toEqual(expect.arrayContaining(['acceptance', 'agent:todo']));
    // Stop names exactly the two recorded bindings, never "every binding".
    expect(world.stopCalls).toEqual([[
      { bindingId: 'binding_a', generation: 1, agentParticipantId: 'participant_a' },
      { bindingId: 'binding_b', generation: 1, agentParticipantId: 'participant_b' },
    ]]);
    expect(report.stop!.aliveBefore).toEqual([true, true]);
    expect(report.stop!.aliveAfter).toEqual([true, true]);
    expect(world.signalled).toEqual([]);
    expect(report.cleanup.map(entry => entry.outcome)).toEqual(['closed', 'closed']);
    expectCleanTail(world, report);
    // Markers are correlation labels; they never reach the report.
    expect(JSON.stringify(report)).not.toContain(world.markers.run);
  });

  it('does not pass timed sends that carry no event-linked read/ack evidence', async () => {
    const world = createWorld({ receipts: false });
    const report = await run(world);
    expect(report.verdict).not.toBe('pass');
    expect(report.verdict).toBe('unproven');
    for (const mode of ['steer', 'sync', 'async']) {
      expect(status(report, `handshake:${mode}`)).toBe('pass');
      expect(status(report, `read-ack:${mode}`)).toBe('unproven');
    }
  });

  it('runs only modes both routes prove and records the rest as skipped, never substituted', async () => {
    const input = profileInput();
    const roles = input.roles as Record<string, unknown>[];
    const world = createWorld({}, offlineProfile({ roles: [roles[0], { ...roles[1], capabilities: UNPROVEN_ASYNC_CODEX }] }));
    const report = await run(world);
    expect(report.modes.runnable).toEqual(['steer', 'sync']);
    expect(report.modes.skipped.map(entry => entry.mode)).toEqual(['async']);
    expect(status(report, 'handshake:async')).toBeUndefined();
    expect(report.verdict).toBe('pass');
  });

  it('keeps a mode the control reports unsupported unproven instead of assuming the server default', async () => {
    const world = createWorld({ mode: { kind: 'unsupported', reason: 'no control' } });
    const report = await run(world);
    expect(status(report, 'handshake:sync')).toBe('unproven');
    expect(report.verdict).toBe('unproven');
    expectCleanTail(world, report);
  });

  it('exercises the modes the route confirms and keeps only the unconfirmed one unproven', async () => {
    const world = createWorld({
      mode: mode => (mode === 'async' ? { kind: 'unsupported', reason: 'async is not effective: support_unknown' } : { kind: 'effective' }),
    });
    const report = await run(world);
    expect(status(report, 'handshake:steer')).toBe('pass');
    expect(status(report, 'handshake:sync')).toBe('pass');
    expect(report.checks.find(entry => entry.check === 'handshake:async'))
      .toEqual({ check: 'handshake:async', status: 'unproven', detail: 'mode control reported unsupported: async is not effective: support_unknown' });
    expect(report.verdict).toBe('unproven');
    expectCleanTail(world, report);
  });

  it('never guesses which same-harness request belongs to which ticket when the Executor recorded no native session', async () => {
    const world = createWorld({ sessions: false });
    const report = await run(world);
    expect(report.errors.join('\n')).toMatch(/timed out waiting for both access grants/);
    expect(status(report, 'native-session:a')).toBe('unproven');
    expect(report.roles.every(role => role.target === null)).toBe(true);
    expect(world.stopCalls).toEqual([]);
    expect(report.verdict).toBe('fail');
    expectCleanTail(world, report);
  });

  it('refuses without touching GitHub or the launcher when another run holds the repository lock', async () => {
    const world = createWorld({ lockHeld: true });
    const report = await run(world);
    expect(report.verdict).toBe('refused');
    expect(world.issues.size).toBe(0);
    expect(world.launcherStarts).toBe(0);
  });

  it('refuses when the human does not confirm the channel, creating no tickets and still closing the launcher', async () => {
    const world = createWorld({ confirmChannel: false });
    const report = await run(world);
    expect(report.verdict).toBe('refused');
    expect(world.issues.size).toBe(0);
    expect(world.serverClosed()).toBe(true);
    expect(world.lockReleased()).toBe(true);
  });

  it('checks both sessions are alive at the hold barrier before Stop', async () => {
    const world = createWorld();
    const report = await run(world);
    expect(status(report, 'alive-at-barrier')).toBe('pass');
    expect(report.stop!.aliveBefore).toEqual([true, true]);
  });

  it('fails a run whose session is gone at the hold barrier, and still stops its bindings', async () => {
    const world = createWorld();
    const report = await run({ ...world, deps: { ...world.deps, aiur: { ...world.deps.aiur, alive: async () => false } } });
    expect(status(report, 'alive-at-barrier')).toBe('fail');
    expect(world.stopCalls).toHaveLength(1);
    expect(report.verdict).toBe('fail');
  });

  it('refuses a stale-generation Stop target locally and never sends it', async () => {
    const world = createWorld({ reannounce: true });
    const report = await run(world);
    expect(world.stopCalls).toEqual([]);
    expect(report.stop!.refusedLocally).toMatch(/stale or mismatched/);
    expect(status(report, 'stop')).toBe('fail');
    expect(report.verdict).toBe('fail');
    expectCleanTail(world, report);
  });

  it('still closes the launcher and the tickets when Stop fails', async () => {
    const world = createWorld({ stopThrows: true });
    const report = await run(world);
    expect(report.verdict).toBe('fail');
    expect(report.errors.join('\n')).toMatch(/stop transport failed/);
    expectCleanTail(world, report);
  });

  it('fails a no-op Stop that leaves bindings live and delivery flowing', async () => {
    const world = createWorld({ deliverAfterStop: true });
    const report = await run(world);
    expect(status(report, 'stop-revoked')).toBe('fail');
    expect(status(report, 'no-delivery-after-stop')).toBe('fail');
    expect(report.verdict).toBe('fail');
  });

  it('fails a Stop that ends the user CLI sessions', async () => {
    const world = createWorld({ stopKillsSessions: true });
    const report = await run(world);
    expect(status(report, 'sessions-untouched')).toBe('fail');
    expect(report.verdict).toBe('fail');
  });

  it('times out a pair that never handshakes, then still Stops, closes the launcher and cleans up', async () => {
    const world = createWorld({ handshake: false });
    const report = await run(world);
    expect(report.errors.join('\n')).toMatch(/timed out waiting for the steer handshake/);
    expect(world.stopCalls).toHaveLength(1);
    expect(report.verdict).toBe('fail');
    expectCleanTail(world, report);
  });

  it('continues cleanup past a ticket that fails to close', async () => {
    const world = createWorld({ closeFailsFor: 1001 });
    const report = await run(world);
    expect(report.cleanup).toEqual([
      { ticket: 1001, outcome: 'failed', detail: 'github refused the close' },
      { ticket: 1002, outcome: 'closed', detail: 'closed' },
    ]);
    expect(world.lockReleased()).toBe(true);
  });

  it('refuses to close an issue that lost its acceptance label or run marker', async () => {
    const world = createWorld();
    const originalClose = world.deps.github.linkedPullRequests;
    // Tamper after the run's evidence is gathered, before cleanup.
    (world.deps.github as { linkedPullRequests: typeof originalClose }).linkedPullRequests = async (repository, number) => {
      if (number === 1001) world.editIssue(1001, { labels: ['agent:todo'] });
      if (number === 1002) world.editIssue(1002, { body: 'someone else\'s issue' });
      return originalClose(repository, number);
    };
    const report = await run(world);
    expect(report.cleanup.map(entry => entry.outcome)).toEqual(['refused', 'refused']);
    expect(world.closed).toEqual([]);
  });
});
