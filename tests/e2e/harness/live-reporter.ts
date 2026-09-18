// Run-level live gate for `pnpm test:e2e` and `pnpm test:conformance`. In live mode
// the run fails unless at least one tagged live case passed. A case is tagged only by
// `describeLive` after it returned live evidence, so a test merely named `live: …`
// does not count. This also catches name filters or file selections that skip every
// live case, and a live run with no live entries at all.

import type { Reporter, TestModule } from 'vitest/node';
import { LIVE_META_KEY, liveEnvironment } from './live';

function isLiveCase(meta: unknown): boolean {
  const tag = (meta as Record<string, unknown>)[LIVE_META_KEY] as { records?: unknown; mode?: unknown } | undefined;
  return typeof tag?.records === 'number' && tag.records > 0 && typeof tag.mode === 'string' && tag.mode !== 'fake-contract';
}

export default class LiveGateReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (!liveEnvironment().enabled) return;
    const passed = testModules.flatMap(module => [...module.children.allTests('passed')])
      .filter(test => isLiveCase(test.meta()));
    if (passed.length === 0) {
      console.error('live mode: no live case passed with live evidence; an all-skipped live run is not acceptance');
      process.exitCode = 1;
    }
  }
}
