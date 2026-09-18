// Live acceptance gate. Without explicit opt-in to a disposable environment, live
// suites are skipped with a visible reason. With it, an entry fails unless at least
// one live case actually ran: an all-skipped live run is not acceptance.

import { afterAll, describe, it } from 'vitest';

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

export interface LiveTally {
  /** Marks one live case as having executed its body. */
  ran(name: string): void;
  executed(): readonly string[];
  /** Throws when no live case executed. */
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

export type LiveCase = (name: string, body: (env: Readonly<{ disposableEnv: string }>) => Promise<void>) => void;

/**
 * Declares a live acceptance entry. Consumers (KHA-138/139) register their scenarios
 * through `liveCase`; this module selects no provider and starts no daemon.
 */
export function describeLive(
  entry: string,
  register: (liveCase: LiveCase) => void,
  environment: LiveEnvironment = liveEnvironment(),
): void {
  if (!environment.enabled) {
    describe.skip(`${entry} (live skipped: ${environment.reason})`, () => {
      register(name => it.skip(name, () => undefined));
    });
    return;
  }
  const tally = createLiveTally();
  describe(entry, () => {
    // Counted only after the body completes, so a case that skips itself midway
    // does not satisfy the tally.
    register((name, body) => it(name, async () => {
      await body({ disposableEnv: environment.disposableEnv });
      tally.ran(name);
    }));
    afterAll(() => tally.assertAnyRan(entry));
  });
}
