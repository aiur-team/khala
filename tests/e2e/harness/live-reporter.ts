// Run-level live gate for `pnpm test:e2e`. In live mode the run fails unless at least
// one live case passed. This also catches name filters or file selections that skip
// every live case, and a live run with no live entries at all.

import type { Reporter, TestModule } from 'vitest/node';
import { LIVE_CASE_PREFIX, liveEnvironment } from './live';

export default class LiveGateReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (!liveEnvironment().enabled) return;
    const passed = testModules.flatMap(module => [...module.children.allTests('passed')])
      .filter(test => test.name.startsWith(LIVE_CASE_PREFIX));
    if (passed.length === 0) {
      console.error('live mode: no live case passed; an all-skipped live run is not acceptance');
      process.exitCode = 1;
    }
  }
}
