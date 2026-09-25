// Reference implementation of the narrow opener adapter contract
// (adapter-contract.md). `internal-launcher` ports this seam; it always prints
// the manual local URL itself and treats every `opened: false` as a normal,
// non-fatal outcome.

import { spawn as childSpawn } from 'node:child_process';
import { containsLeak, leakForms } from './canary.mjs';
import { OPENER_ENV, OPENER_ENV_REMOVED, automaticOpenDecision } from './profile.mjs';
import { prepareHandoff } from './strategies.mjs';

export const OPENER_COMMAND = 'xdg-open';

export async function openBootstrap({
  bootstrapUrl,
  credential,
  runtimeProfile,
  matrix,
  handoffParent,
  env,
  spawn = childSpawn,
}) {
  const decision = automaticOpenDecision(runtimeProfile, matrix);
  if (!decision.open) return { opened: false, reason: decision.reason };

  const handoff = await prepareHandoff('private-file', { url: bootstrapUrl, parentDir: handoffParent });
  const openerEnv = { ...env, ...OPENER_ENV };
  for (const key of OPENER_ENV_REMOVED) delete openerEnv[key];
  if (containsLeak(JSON.stringify([handoff.argv, openerEnv]), leakForms(credential))) {
    await handoff.cleanup();
    return { opened: false, reason: 'credential would reach opener argv or environment' };
  }

  const started = await new Promise(resolve => {
    try {
      const child = spawn(OPENER_COMMAND, handoff.argv, { env: openerEnv, detached: true, stdio: 'ignore' });
      child.once('spawn', () => { child.unref(); resolve(null); });
      child.once('error', error => resolve(error.code ?? 'spawn failed'));
    } catch (error) {
      resolve(error.code ?? 'spawn failed');
    }
  });
  if (started !== null) {
    await handoff.cleanup();
    return { opened: false, reason: `opener did not start: ${started}` };
  }
  // The caller removes the handoff directory once the bootstrap exchange
  // succeeds, on a short deadline, and on shutdown, whichever comes first.
  return { opened: true, profileId: decision.profileId, cleanup: handoff.cleanup };
}
