import { readFile } from 'node:fs/promises';

type Proof = {
  observations?: { routeA?: { liveAttempted?: boolean; result?: string } };
  contractMapping?: { existingSession?: string; immediateNotification?: string };
  limitations?: Record<string, boolean>;
  recommendation?: string;
};

const proof = JSON.parse(
  await readFile(new URL('./evidence/live-proof.json', import.meta.url), 'utf8'),
) as Proof;

const required = [
  [proof.observations?.routeA?.liveAttempted, false, 'Route A must remain unexercised'],
  [proof.observations?.routeA?.result, 'not_exercised', 'Route A result'],
  [proof.contractMapping?.existingSession, 'unsupported', 'existing-session mapping'],
  [proof.contractMapping?.immediateNotification, 'unsupported', 'notification mapping'],
  [proof.recommendation, 'keep native support fail-closed', 'recommendation'],
] as const;

for (const [actual, expected, label] of required) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

for (const key of ['channelsExercised', 'rawStreamsRetained', 'perCaseTimestampsRetained', 'exitCodesAndSignalsRetained', 'cleanShutdownResumeTested']) {
  if (proof.limitations?.[key] !== false) throw new Error(`${key} must remain explicitly false`);
}

if (proof.limitations?.inventoryIsCuratedProvenance !== true) {
  throw new Error('inventoryIsCuratedProvenance must remain explicitly true');
}

console.log('Claude native evidence is fail-closed and internally consistent.');
