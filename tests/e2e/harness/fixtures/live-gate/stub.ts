// A stand-in live driver for the live gate's own fixture runs. It proves nothing about
// any real component; it only lets a fixture produce a live manifest the way a real
// driver would, through its handle.

import type { EvidenceManifest } from '../../evidence';
import { type DriverHandle, type ScenarioDriver, createScenarioHarness } from '../../scenario';
import { controlsFor } from '../../../../conformance/subjects';

export async function stubLiveManifest(records: number): Promise<EvidenceManifest> {
  let handle: DriverHandle | undefined;
  const driver: ScenarioDriver = {
    name: 'gate-stub', mode: 'live-harness', source: { component: 'gate-stub', version: '0' }, faults: [],
    attach: issued => { handle = issued; }, close: async () => undefined,
  };
  const scenario = await createScenarioHarness({
    runId: 'live-gate', mode: 'live-harness', owners: [{ seed: 'a', controls: controlsFor('a') }], sources: [], drivers: [driver],
  });
  for (let index = 0; index < records; index += 1) handle!.record('model.input', { ownerId: 'owner-a', operationId: `release-${index}` });
  await scenario.close();
  return scenario.manifest();
}
