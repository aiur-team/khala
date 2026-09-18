// Scenario driver: isolated owners, per-owner clocks and state directories, fault
// injection, evidence, and ordered cleanup. Real or fake behaviour comes from the
// drivers a scenario registers; this module selects no provider or harness.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type ScenarioClock, createFakeClock, createMonotonicClock } from './clock';
import {
  type EvidenceManifest, type EvidenceMode, type EvidenceRecord, type SourceVersion, createEvidenceLog, isLiveMode,
} from './evidence';
import { type ArmedFault, type Fault, type FaultInjector, createFaultInjector } from './faults';
import { type OwnerControls, type OwnerFixture, assertIndependentOwners, createOwnerFixture } from './owners';

/**
 * An injected browser, API, connector or native harness driver. Its mode must equal
 * the scenario's, so fake and live behaviour never share one evidence stream.
 */
export interface ScenarioDriver {
  readonly name: string;
  readonly mode: EvidenceMode;
  readonly source: SourceVersion;
  /** Faults this driver can enact at their documented boundary. */
  readonly faults: readonly Fault[];
  /** Arms a fault in the real component; fake drivers rely on `faults.checkpoint`. */
  inject?(fault: Fault, owner: OwnerFixture): Promise<void>;
  close(): Promise<void>;
}

export type ScenarioConfig = Readonly<{
  runId: string;
  mode: EvidenceMode;
  owners: readonly Readonly<{ seed: string; controls: OwnerControls }>[];
  /** Exact versions of everything the evidence describes; required for live modes. */
  sources: readonly SourceVersion[];
  drivers?: readonly ScenarioDriver[];
  /** Parent for per-owner state directories; defaults to the OS temp directory. */
  stateRoot?: string;
}>;

export type Leftover = Readonly<{ label: string; ownerId: string | null; reason: string }>;

export type CleanupReport = Readonly<{
  disposed: readonly string[];
  leftovers: readonly Leftover[];
  unfiredFaults: readonly ArmedFault[];
}>;

export interface ScenarioHarness {
  readonly runId: string;
  readonly mode: EvidenceMode;
  readonly owners: readonly OwnerFixture[];
  readonly faults: FaultInjector;
  owner(seed: string): OwnerFixture;
  clock(ownerId: string): ScenarioClock;
  /** A state directory private to one owner; never shared with another owner. */
  stateDir(ownerId: string): string;
  inject(fault: Fault, targetOwnerId: string): Promise<void>;
  record(kind: string, subject: Readonly<{ ownerId: string; operationId: string }>): EvidenceRecord;
  evidence(): ReadonlyArray<EvidenceRecord>;
  manifest(): EvidenceManifest;
  /** Registers disposal of a disposable resource; run in reverse order on close. */
  defer(label: string, ownerId: string | null, dispose: () => Promise<void>): void;
  close(): Promise<CleanupReport>;
}

const reason = (error: unknown): string => (error instanceof Error ? error.name : 'non_error_thrown');

export async function createScenarioHarness(config: ScenarioConfig): Promise<ScenarioHarness> {
  const owners = config.owners.map(({ seed, controls }) => createOwnerFixture(seed, controls));
  if (owners.length === 0) throw new Error('a scenario needs at least one owner');
  assertIndependentOwners(owners);

  const drivers = config.drivers ?? [];
  // Live evidence comes from a registered live driver, never from in-process fakes.
  if (isLiveMode(config.mode) && drivers.length === 0) {
    throw new Error(`a ${config.mode} scenario needs at least one registered ${config.mode} driver`);
  }
  for (const driver of drivers) {
    if (driver.mode !== config.mode) {
      throw new Error(`driver ${driver.name} produces ${driver.mode} evidence in a ${config.mode} scenario`);
    }
  }
  const evidence = createEvidenceLog({
    runId: config.runId,
    mode: config.mode,
    sources: [...config.sources, ...drivers.map(driver => driver.source)],
  });

  const live = isLiveMode(config.mode);
  const clocks = new Map<string, ScenarioClock>(owners.map(owner => [
    owner.ownerId,
    live ? createMonotonicClock(`${config.runId}/${owner.seed}`) : createFakeClock(`${config.runId}/${owner.seed}`),
  ]));
  const clock = (ownerId: string): ScenarioClock => {
    const found = clocks.get(ownerId);
    if (!found) throw new Error(`unknown owner ${ownerId}`);
    return found;
  };

  const cleanups: { label: string; ownerId: string | null; dispose: () => Promise<void> }[] = [];
  const stateRoot = config.stateRoot ?? tmpdir();
  const stateDirs = new Map<string, string>();
  try {
    for (const owner of owners) {
      const directory = await mkdtemp(path.join(stateRoot, `khala-e2e-${owner.seed}-`));
      stateDirs.set(owner.ownerId, directory);
      cleanups.push({
        label: `state-dir:${owner.seed}`,
        ownerId: owner.ownerId,
        dispose: () => rm(directory, { recursive: true, force: true }),
      });
    }
  } catch (error) {
    await Promise.allSettled([...stateDirs.values()].map(directory => rm(directory, { recursive: true, force: true })));
    throw error;
  }
  for (const driver of drivers) cleanups.push({ label: `driver:${driver.name}`, ownerId: null, dispose: () => driver.close() });

  const faults = createFaultInjector(evidence, clock);
  const byId = (ownerId: string): OwnerFixture => {
    const owner = owners.find(candidate => candidate.ownerId === ownerId);
    if (!owner) throw new Error(`unknown owner ${ownerId}`);
    return owner;
  };
  let closed = false;

  return {
    runId: evidence.runId,
    mode: config.mode,
    owners: Object.freeze(owners),
    faults,
    owner(seed) {
      const owner = owners.find(candidate => candidate.seed === seed);
      if (!owner) throw new Error(`unknown owner seed ${seed}`);
      return owner;
    },
    clock,
    stateDir(ownerId) {
      byId(ownerId);
      return stateDirs.get(ownerId)!;
    },
    async inject(fault, targetOwnerId) {
      const owner = byId(targetOwnerId);
      const capable = drivers.filter(driver => driver.faults.includes(fault));
      // A live scenario has no in-process fake to enact the fault; refusing is honest.
      if (live && capable.length === 0) throw new Error(`no registered driver can inject ${fault}`);
      faults.arm(fault, owner.ownerId);
      for (const driver of capable) await driver.inject?.(fault, owner);
    },
    record: (kind, subject) => evidence.record(kind, subject, clock(subject.ownerId)),
    evidence: () => evidence.records(),
    manifest: () => evidence.manifest(),
    defer(label, ownerId, dispose) {
      if (closed) throw new Error('scenario is closed');
      if (ownerId !== null) byId(ownerId);
      cleanups.push({ label, ownerId, dispose });
    },
    async close() {
      if (closed) throw new Error('scenario already closed');
      closed = true;
      const disposed: string[] = [];
      const leftovers: Leftover[] = [];
      // Reverse order: resources registered later may depend on earlier ones.
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup.dispose();
          disposed.push(cleanup.label);
        } catch (error) {
          leftovers.push({ label: cleanup.label, ownerId: cleanup.ownerId, reason: reason(error) });
        }
      }
      return Object.freeze({ disposed, leftovers, unfiredFaults: faults.unfired() });
    },
  };
}

/** Fails a scenario whose cleanup left resources behind or whose faults never fired. */
export function assertCleanClose(report: CleanupReport): void {
  const problems = [
    ...report.leftovers.map(leftover => `leftover ${leftover.label}: ${leftover.reason}`),
    ...report.unfiredFaults.map(armed => `fault ${armed.fault} for ${armed.ownerId} never reached its boundary`),
  ];
  if (problems.length > 0) throw new Error(problems.join('; '));
}
