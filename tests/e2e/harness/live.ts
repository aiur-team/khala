// Live acceptance gate. Without explicit opt-in to a disposable environment, live
// suites are skipped with a visible reason. With it, an entry fails unless at least
// one live case ran to completion: an all-skipped live run is not acceptance. A live
// case proves it ran by returning the live evidence it produced.

import { type TestContext, afterAll, describe, it } from 'vitest';
import { type EvidenceManifest, isIssuedManifest, isLiveMode } from './evidence';

/** Prefix on every live case name, for readers only; the gate counts tagged cases. */
export const LIVE_CASE_PREFIX = 'live: ';

/** `task.meta` key the run-level gate in `live-reporter.ts` counts. */
export const LIVE_META_KEY = 'khalaLive';

export type LiveCaseMeta = Readonly<{ entry: string; mode: string; records: number }>;

export type LiveEnvironment =
  | Readonly<{ enabled: true; disposableEnv: string }>
  | Readonly<{ enabled: false; reason: string }>;

export function liveEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): LiveEnvironment {
  if (env.KHALA_E2E_LIVE !== '1') return { enabled: false, reason: 'KHALA_E2E_LIVE is not 1' };
  const disposableEnv = env.KHALA_E2E_DISPOSABLE_ENV?.trim();
  if (!disposableEnv) {
    // Opting in without naming a disposable environment is a configuration error,
    // never a quiet skip.
    throw new Error('KHALA_E2E_LIVE=1 requires KHALA_E2E_DISPOSABLE_ENV naming a disposable environment');
  }
  return { enabled: true, disposableEnv };
}

/**
 * Refuses anything but live evidence an evidence log issued, with at least one record,
 * every record produced by a registered driver.
 */
export function assertLiveManifest(manifest: EvidenceManifest | undefined, what: string): EvidenceManifest {
  if (!manifest || !isIssuedManifest(manifest)) throw new Error(`${what} returned no evidence manifest issued by a scenario`);
  if (!isLiveMode(manifest.mode)) throw new Error(`${what} returned ${manifest.mode} evidence; live acceptance needs live evidence`);
  if (manifest.records.length === 0) throw new Error(`${what} returned a live manifest with no records`);
  if (manifest.records.some(record => record.mode !== manifest.mode || record.driver === null)) {
    throw new Error(`${what} returned records that no registered live driver produced`);
  }
  return manifest;
}

export interface LiveTally {
  /** Marks one live case as having completed with live evidence. */
  ran(name: string): void;
  executed(): readonly string[];
  /** Throws when no live case completed. */
  assertAnyRan(entry: string): void;
}

export function createLiveTally(): LiveTally {
  const executed: string[] = [];
  return {
    ran: name => {
      executed.push(name);
    },
    executed: () => [...executed],
    assertAnyRan(entry) {
      if (executed.length === 0) throw new Error(`${entry}: live mode ran no live case; all-skipped is not acceptance`);
    },
  };
}

export type LiveCaseContext = Readonly<{
  disposableEnv: string;
  /** Skips this case with a reason; it then does not count towards the entry. */
  skip(reason: string): never;
}>;

export type LiveCase = (name: string, body: (context: LiveCaseContext) => Promise<EvidenceManifest>) => void;

/**
 * Declares a live acceptance entry. Consumers (KHA-138/139) register their scenarios
 * through `liveCase`, and each case returns the manifest of the live scenario it drove.
 * This module selects no provider and starts no daemon.
 */
export function describeLive(
  entry: string,
  register: (liveCase: LiveCase) => void,
  environment: LiveEnvironment = liveEnvironment(),
): void {
  if (!environment.enabled) {
    describe.skip(`${entry} (live skipped: ${environment.reason})`, () => {
      register(name => it.skip(`${LIVE_CASE_PREFIX}${name}`, () => undefined));
    });
    return;
  }
  const tally = createLiveTally();
  describe(entry, () => {
    // Counted and tagged only after the body returns live evidence, so a case that
    // skips itself or proves nothing does not satisfy either gate.
    register((name, body) => it(`${LIVE_CASE_PREFIX}${name}`, async (context: TestContext) => {
      const manifest = assertLiveManifest(await body({
        disposableEnv: environment.disposableEnv,
        skip: reason => {
          context.skip(reason);
          throw new Error('unreachable: skip did not interrupt the case');
        },
      }), `${entry} / ${name}`);
      tally.ran(name);
      const meta: LiveCaseMeta = { entry, mode: manifest.mode, records: manifest.records.length };
      (context.task.meta as Record<string, unknown>)[LIVE_META_KEY] = meta;
    }));
    afterAll(() => tally.assertAnyRan(entry));
  });
}
