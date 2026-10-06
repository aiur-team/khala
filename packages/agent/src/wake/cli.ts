import * as fs from 'node:fs/promises';
import path from 'node:path';
import { adapterFor } from '../harness';
import { resolveSources } from '../harness/session-sources';
import { CURSOR_DEFAULT_SESSION } from '../cursor';
import { SESSION_ID_PATTERN, stateRoot, filesForDir } from '../state';
import { updateWakeSettings } from './shared';
import { resetWakeDriver } from './shared/nonce';
import { WAKE_HARNESSES, wakeDrivers, wakeStatus } from './status';

export type WakeCliDeps = { env?: NodeJS.ProcessEnv; stdout?: (line: string) => void; stderr?: (line: string) => void };
export const WAKE_USAGE = 'usage: khala wake on|off|status [--driver <d>] [--harness <id>] [--json]';
export async function sessionIds(harness: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  try { return (await fs.readdir(path.join(stateRoot(env), harness), { withFileTypes: true })).filter(entry => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name)).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function setWake(harness: string, drivers: readonly string[], on: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  const root = stateRoot(env);
  const at = new Date().toISOString();
  // Persist machine-wide withdrawal before touching session state.
  await updateWakeSettings(root, settings => {
    for (const driver of drivers) {
      const key = `${harness}/${driver}`;
      if (on) { settings.consent[key] = { at }; delete settings.off[key]; }
      else { delete settings.consent[key]; settings.off[key] = { at }; }
    }
  });
  if (on) for (const id of await sessionIds(harness, env)) {
    for (const driver of drivers) {
      const dir = filesForDir(path.join(root, harness, id)).dir;
      await resetWakeDriver(dir, driver);
      if (harness === 'qwen' && driver === 'socket') await fs.rm(path.join(dir, 'qwen-receipt.json'), { force: true });
    }
  }
}
export function consentLine(harness: string, drivers: readonly string[], on: boolean): string {
  return on
    ? `Idle wake is on (${drivers.join(', ')}): Khala may send a fixed wake line into this agent's existing session when messages wait and the prompt is empty. Run \`khala wake off --harness ${harness}\` to turn it off.`
    : `Idle wake is off for ${drivers.join(', ')}. Run \`khala wake on --harness ${harness}\` to turn it on.`;
}
async function currentSessionId(harness: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const adapter = adapterFor(harness);
  if (!adapter) return undefined;
  const session = await resolveSources(adapter.sessionSources.filter(source => source.kind !== 'process'), undefined, env, { harness: adapter.id });
  return session?.sessionId !== CURSOR_DEFAULT_SESSION ? session?.sessionId : undefined;
}
export async function runWake(argv: readonly string[], deps: WakeCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const [command, ...flags] = argv;
  let harness: string | undefined;
  let driver: string | undefined;
  let json = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--json') json = true;
    else if ((flag === '--harness' || flag === '--driver') && flags[i + 1] && !flags[i + 1]!.startsWith('--')) {
      const value = flags[++i]!;
      if (flag === '--harness') harness = value; else driver = value;
    } else { err(WAKE_USAGE); return 2; }
  }
  if (!['on', 'off', 'status'].includes(command ?? '')) { err(WAKE_USAGE); return 2; }
  if (harness && !WAKE_HARNESSES.includes(harness)) { err(`Unknown harness ${harness}. Valid harnesses: ${WAKE_HARNESSES.join(', ')}`); return 2; }
  const candidates = harness ? [harness] : WAKE_HARNESSES;
  const valid = [...new Set(candidates.flatMap(id => wakeDrivers(id).map(item => item.id)))];
  if (driver && !valid.includes(driver)) { err(`Unknown driver ${driver}. Valid drivers: ${valid.join(', ') || 'none'}`); return 2; }
  if (!harness && command !== 'status') {
    for (const id of WAKE_HARNESSES) {
      if (await currentSessionId(id, env) !== undefined) { harness = id; break; }
    }
    if (!harness && driver) {
      const matches = WAKE_HARNESSES.filter(id => wakeDrivers(id).some(item => item.id === driver));
      if (matches.length === 1) harness = matches[0];
    }
    if (!harness) { err(`Select --harness. Valid harnesses: ${WAKE_HARNESSES.join(', ')}`); return 2; }
    if (driver && !wakeDrivers(harness).some(item => item.id === driver)) {
      err(`Unknown driver ${driver}. Valid drivers: ${wakeDrivers(harness).map(item => item.id).join(', ') || 'none'}`);
      return 2;
    }
  }
  const harnesses = harness ? [harness] : WAKE_HARNESSES;
  if (command === 'status') {
    const rows = [];
    for (const id of harnesses) {
      const sessionId = await currentSessionId(id, env);
      rows.push(...await wakeStatus(id, { env, ...(sessionId ? { files: filesForDir(path.join(stateRoot(env), id, sessionId)), sessionId } : {}) }));
    }
    const selected = driver ? rows.filter(row => row.driver === driver) : rows;
    out(json ? JSON.stringify(selected) : selected.map(row => `${row.harness}\t${row.driver}\t${row.rung}\t${row.state}\t${row.reason}${row.remedy ? ` ${row.remedy}` : ''}`).join('\n'));
  } else {
    const all = wakeDrivers(harness!);
    const selected = driver ? [driver] : command === 'on' ? [all.find(item => item.optIn)?.id ?? all[0]?.id].filter((id): id is string => !!id) : all.map(item => item.id);
    if (!selected.length) { err(`No wake drivers for ${harness}.`); return 2; }
    await setWake(harness!, selected, command === 'on', env);
    const message = consentLine(harness!, selected, command === 'on');
    out(json ? JSON.stringify({ harness, drivers: selected, on: command === 'on', message }) : message);
  }
  return 0;
}
export default runWake;
