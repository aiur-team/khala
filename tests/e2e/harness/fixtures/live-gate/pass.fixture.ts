import { describeLive } from '../../live';
import { stubLiveManifest } from './stub';

describeLive('gate-pass', liveCase => {
  liveCase('returns live evidence', () => stubLiveManifest(1));
});
