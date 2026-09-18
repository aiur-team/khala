import { describeLive } from '../../live';
import { stubLiveManifest } from './stub';

// One entry passes, so the run-level gate is satisfied; the other skips its only case,
// which only the per-entry tally catches.
describeLive('gate-covered', liveCase => {
  liveCase('returns live evidence', () => stubLiveManifest(1));
});

describeLive('gate-uncovered', liveCase => {
  liveCase('skips itself', async ({ skip }) => skip('provider not configured in this environment'));
});
