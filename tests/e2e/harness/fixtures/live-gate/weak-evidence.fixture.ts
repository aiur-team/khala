import { createEvidenceLog } from '../../evidence';
import { describeLive } from '../../live';
import { stubLiveManifest } from './stub';

describeLive('gate-weak-evidence', liveCase => {
  liveCase('returns fake evidence', async () => createEvidenceLog({ runId: 'fake', mode: 'fake-contract', sources: [] }).manifest());
  liveCase('returns an empty live manifest', () => stubLiveManifest(0));
  liveCase('returns a hand-built manifest', async () => ({ ...(await stubLiveManifest(1)) }));
});
