import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controlsFor } from '../../conformance/subjects';
import { CrossClockComparison, createFakeClock, createMonotonicClock, elapsed } from './clock';
import { EvidenceError, combineManifests, createEvidenceLog, reading, requireEvidence } from './evidence';
import { createLiveTally, liveEnvironment } from './live';
import { ConflatedOwners, assertIndependentOwners, createOwnerFixture } from './owners';
import { type ScenarioDriver, assertCleanClose, createScenarioHarness } from './scenario';

const owners = (seeds: readonly string[]) => seeds.map(seed => ({ seed, controls: controlsFor(seed) }));

describe('owner fixtures', () => {
  it('keeps human, agent, device, binding and session distinct per owner', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(seed => createOwnerFixture(seed, controlsFor(seed)));
    expect(() => assertIndependentOwners([a!, b!, c!])).not.toThrow();
    expect(new Set([a!.humanParticipantId, a!.agentParticipantId]).size).toBe(2);
    expect(a!.profile).toEqual(b!.profile); // colliding unverified metadata is allowed
  });

  it('refuses owners that share a verified identity', () => {
    const a = createOwnerFixture('a', controlsFor('a'));
    const sameSession = createOwnerFixture('b', { ...controlsFor('b'), sessionId: a.binding.sessionId });
    expect(() => assertIndependentOwners([a, sameSession])).toThrow(ConflatedOwners);
    expect(() => assertIndependentOwners([a, a])).toThrow(/share ownerId owner-a/);
  });

  it('rejects invalid controls instead of defaulting them', () => {
    expect(() => createOwnerFixture('B', controlsFor('b'))).toThrow(/seed/);
    expect(() => createOwnerFixture('b', { ...controlsFor('b'), generation: -1 })).toThrow(/binding/);
    expect(() => createOwnerFixture('b', { ...controlsFor('b'), policyVersion: 1.5 })).toThrow(/policyVersion/);
  });
});

describe('clocks', () => {
  it('advances each fake clock independently and runs timers in order', async () => {
    const a = createFakeClock('a');
    const b = createFakeClock('b', 1_000);
    const order: string[] = [];
    void a.sleep(20).then(() => order.push('a20'));
    void a.sleep(10).then(() => order.push('a10'));
    void b.sleep(5).then(() => order.push('b5'));
    await a.advance(25);
    expect(order).toEqual(['a10', 'a20']);
    expect([a.now(), b.now(), a.pending(), b.pending()]).toEqual([25, 1_000, 0, 1]);
    expect(a.wallClock()).toBeNull();
  });

  it('refuses to compute latency across independent clocks', () => {
    expect(elapsed({ clockId: 'a', at: 1 }, { clockId: 'a', at: 4 })).toBe(3);
    expect(() => elapsed({ clockId: 'a', at: 1 }, { clockId: 'b', at: 4 })).toThrow(CrossClockComparison);
  });

  it('gives live clocks monotonic time with wall-clock provenance', () => {
    const clock = createMonotonicClock('live');
    expect(clock.now()).toBeGreaterThanOrEqual(0);
    expect(clock.wallClock()).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe('evidence', () => {
  const fakeClock = createFakeClock('c');

  it('requires a mode and names sources for live evidence', () => {
    expect(() => createEvidenceLog({ runId: 'r', mode: 'live-harness', sources: [] })).toThrow(/source versions/);
    const live = createEvidenceLog({ runId: 'r', mode: 'live-sdk', sources: [{ component: 'sdk', version: '1.0.0' }] });
    expect(() => live.record('k', { ownerId: 'o', operationId: 'op' }, fakeClock)).toThrow(/fake clock/);
  });

  it('keeps free text out of records', () => {
    const log = createEvidenceLog({ runId: 'r', mode: 'fake-contract', sources: [] });
    expect(() => log.record('model.input', { ownerId: 'owner-a', operationId: 'Review the API change.' }, fakeClock)).toThrow(EvidenceError);
    const record = log.record('model.input', { ownerId: 'owner-a', operationId: 'release-1' }, fakeClock);
    expect(Object.keys(record).sort()).toEqual(['at', 'clockId', 'clockSource', 'kind', 'mode', 'operationId', 'ownerId', 'wallClock']);
    expect(reading(record)).toEqual({ clockId: 'c', at: 0 });
  });

  it('never combines fake and live manifests', () => {
    const fake = createEvidenceLog({ runId: 'r', mode: 'fake-contract', sources: [] }).manifest();
    const live = createEvidenceLog({ runId: 'r', mode: 'live-harness', sources: [{ component: 'codex', version: '0.154.0' }] }).manifest();
    expect(() => combineManifests([fake, live])).toThrow(/cannot mix fake-contract and live-harness/);
    const other = createEvidenceLog({ runId: 'r', mode: 'live-harness', sources: [{ component: 'codex', version: '0.155.0' }] }).manifest();
    expect(() => combineManifests([live, other])).toThrow(/conflicting versions for codex/);
    expect(combineManifests([live, live]).sources).toEqual([{ component: 'codex', version: '0.154.0' }]);
  });

  it('requires queries to name acceptable modes', () => {
    expect(() => requireEvidence([], { kind: 'x', modes: [] })).toThrow(/must name the modes/);
    expect(() => requireEvidence([], { kind: 'x', modes: ['live-harness'] })).toThrow('no x evidence recorded');
  });
});

describe('scenario harness', () => {
  const driver = (overrides: Partial<ScenarioDriver> = {}): ScenarioDriver => ({
    name: 'fake-driver',
    mode: 'fake-contract',
    source: { component: 'fake-driver', version: '0' },
    faults: [],
    close: async () => undefined,
    ...overrides,
  });

  it('gives each owner a private state directory and its own clock, and removes them on close', async () => {
    const harness = await createScenarioHarness({ runId: 'iso', mode: 'fake-contract', owners: owners(['a', 'b', 'c']), sources: [] });
    const directories = harness.owners.map(owner => harness.stateDir(owner.ownerId));
    expect(new Set(directories).size).toBe(3);
    expect(new Set(harness.owners.map(owner => harness.clock(owner.ownerId).id)).size).toBe(3);
    const report = await harness.close();
    assertCleanClose(report);
    expect(directories.some(directory => existsSync(directory))).toBe(false);
  });

  it('refuses a driver whose evidence mode differs from the scenario', async () => {
    await expect(createScenarioHarness({ runId: 'mix', mode: 'fake-contract', owners: owners(['a']), sources: [], drivers: [driver({ mode: 'live-sdk' })] }))
      .rejects.toThrow(/produces live-sdk evidence in a fake-contract scenario/);
  });

  it('refuses a live scenario with no registered live driver', async () => {
    await expect(createScenarioHarness({ runId: 'bare', mode: 'live-harness', owners: owners(['a']), sources: [{ component: 'codex', version: '0.154.0' }] }))
      .rejects.toThrow(/needs at least one registered live-harness driver/);
  });

  it('refuses a live fault that no registered driver can enact', async () => {
    const harness = await createScenarioHarness({
      runId: 'live', mode: 'live-harness', owners: owners(['a']), sources: [],
      drivers: [driver({ mode: 'live-harness', faults: ['session_busy'] })],
    });
    await expect(harness.inject('session_exit', 'owner-a')).rejects.toThrow(/no registered driver can inject session_exit/);
    const injected: string[] = [];
    await harness.close();
    const second = await createScenarioHarness({
      runId: 'live2', mode: 'live-harness', owners: owners(['a']), sources: [],
      drivers: [driver({ mode: 'live-harness', faults: ['session_busy'], inject: async fault => { injected.push(fault); } })],
    });
    await second.inject('session_busy', 'owner-a');
    expect(injected).toEqual(['session_busy']);
    expect(second.manifest().sources).toEqual([{ component: 'fake-driver', version: '0' }]);
    expect(second.clock('owner-a').source).toBe('monotonic');
    second.faults.checkpoint('harness.accept', 'owner-a', 'op-1');
    await second.close();
  });

  it('reports cleanup leftovers without skipping later disposals', async () => {
    const harness = await createScenarioHarness({ runId: 'cleanup', mode: 'fake-contract', owners: owners(['a', 'b']), sources: [] });
    const disposed: string[] = [];
    harness.defer('first', 'owner-a', async () => { disposed.push('first'); });
    harness.defer('broken', 'owner-b', async () => { throw new TypeError('secret detail'); });
    const report = await harness.close();
    expect(disposed).toEqual(['first']);
    expect(report.leftovers).toEqual([{ label: 'broken', ownerId: 'owner-b', reason: 'TypeError' }]);
    expect(report.disposed).toContain('state-dir:a');
    expect(() => assertCleanClose(report)).toThrow(/leftover broken/);
    await expect(harness.close()).rejects.toThrow(/already closed/);
  });
});

describe('live gate', () => {
  it('skips with a reason unless explicitly enabled for a disposable environment', () => {
    expect(liveEnvironment({})).toEqual({ enabled: false, reason: 'KHALA_E2E_LIVE is not 1' });
    expect(() => liveEnvironment({ KHALA_E2E_LIVE: '1' })).toThrow(/KHALA_E2E_DISPOSABLE_ENV/);
    expect(liveEnvironment({ KHALA_E2E_LIVE: '1', KHALA_E2E_DISPOSABLE_ENV: 'staging-7' })).toEqual({ enabled: true, disposableEnv: 'staging-7' });
  });

  it('fails a live entry in which every live case skipped', () => {
    const tally = createLiveTally();
    expect(() => tally.assertAnyRan('security')).toThrow(/all-skipped is not acceptance/);
    tally.ran('case-1');
    expect(() => tally.assertAnyRan('security')).not.toThrow();
  });
});
