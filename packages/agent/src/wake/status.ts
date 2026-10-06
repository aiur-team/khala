import path from 'node:path';
import { execFile } from 'node:child_process';
import { HARNESS_REGISTRY } from '@khala/contracts/m1/harness';
import { adapterFor } from '../harness';
import { filesForDir, readStateFile, stateRoot, type SessionFiles } from '../state';
import { readWakeSettings, readWakeState } from './shared';
import type { WakeDriver } from './driver';

export const WAKE_STATES = {
  active: { reason: 'Idle wake is on.', remedy: '' },
  needs_consent: { reason: 'Idle wake needs consent.', remedy: 'khala wake on --driver <d>' },
  unavailable: { reason: 'No remote-control API is available.', remedy: '', reasons: {
    queue_missing: 'Codex queue is missing.',
    windows: 'Windows has no supported remote-control API.',
    driver_missing: 'No wake driver is installed for this transport.',
    watcher_missing: 'The Claude watcher is not armed.',
  } },
  disabled: { reason: 'Idle wake is off.', remedy: 'khala wake on --driver <d>' },
  disabled_after_failures: { reason: 'Idle wake was disabled after two unverified wakes.', remedy: 'khala wake on --driver <d>' },
  lapsed: { reason: 'The Claude watcher passed its deadline; any prompt re-arms it.', remedy: 'Send any prompt to re-arm the watcher.' },
  none_by_design: { reason: 'The generic tier has no idle wake by design.', remedy: '' },
} as const;
export type WakeStateName = keyof typeof WAKE_STATES;
export type IdleWakeStatus = { driver: string; state: WakeStateName; reason: string; remedy?: string };
export type WakeStatusRow = IdleWakeStatus & { harness: string; rung: number };
export type WakeUnavailableReason = keyof typeof WAKE_STATES.unavailable.reasons;
export function wakeStatusText(driver: string, state: WakeStateName, unavailableReason?: WakeUnavailableReason): IdleWakeStatus {
  const text = WAKE_STATES[state];
  return { driver, state, reason: state === 'unavailable' && unavailableReason ? WAKE_STATES.unavailable.reasons[unavailableReason] : text.reason, ...(text.remedy ? { remedy: text.remedy.replace('<d>', driver) } : {}) };
}
export type WakeDescriptor = Pick<WakeDriver, 'id' | 'rung' | 'optIn'> & { runtime?: WakeDriver };
/** Consent declarations cover fallback transports before their runtime unit lands. */
export function wakeDrivers(harness: string): WakeDescriptor[] {
  const adapter = adapterFor(harness);
  const drivers: WakeDescriptor[] = (adapter?.wakeLadder ?? []).map(driver => ({ ...driver, runtime: driver }));
  for (const driver of adapter?.wakeConsentDrivers ?? []) if (!drivers.some(item => item.id === driver.id)) drivers.push(driver);
  if (harness === 'claude') drivers.unshift({ id: 'watcher', rung: 2, optIn: false });
  return drivers.sort((a, b) => a.rung - b.rung);
}
/** A bounded read-only probe; no queue command sends a message here. */
async function codexQueueAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise(resolve => {
    execFile('codex', ['queue', '--help'], { env, timeout: 1000, maxBuffer: 16 * 1024, windowsHide: true }, error => resolve(error === null));
  });
}
export async function wakeStatus(harness: string, options: { env?: NodeJS.ProcessEnv; files?: SessionFiles; sessionId?: string } = {}): Promise<WakeStatusRow[]> {
  const env = options.env ?? process.env;
  const settings = await readWakeSettings(stateRoot(env));
  const states = options.files ? await readWakeState(options.files.dir) : {};
  const drivers = wakeDrivers(harness);
  if (!drivers.length) return [{ harness, rung: 0, ...wakeStatusText('none', harness === 'generic' ? 'none_by_design' : 'unavailable', harness === 'generic' ? undefined : 'driver_missing') }];
  const rows: WakeStatusRow[] = [];
  for (const driver of drivers) {
    const key = `${harness}/${driver.id}`;
    let state: WakeStateName;
    let unavailableReason: WakeUnavailableReason | undefined;
    if (Object.hasOwn(settings.off, key)) state = 'disabled';
    else if (states[driver.id]?.disabled) state = 'disabled_after_failures';
    else if (driver.optIn && !Object.hasOwn(settings.consent, key)) state = 'needs_consent';
    else if (driver.id === 'watcher') {
      const watcher = options.files ? await readStateFile<{ state?: string }>(options.files.dir, 'watcher.json') : null;
      state = watcher?.state === 'expired' ? 'lapsed' : watcher?.state === 'armed' ? 'active' : 'unavailable';
      if (state === 'unavailable') unavailableReason = 'watcher_missing';
    } else if (driver.runtime) {
      const files = options.files ?? filesForDir(path.join(stateRoot(env), harness, 'status'));
      const ctx = { files, harness, sessionId: options.sessionId ?? 'status', env, signal: new AbortController().signal, now: Date.now() };
      const available = await driver.runtime.available(ctx) && (harness !== 'codex' || driver.id !== 'queue' || await codexQueueAvailable(env));
      state = available ? 'active' : 'unavailable';
      if (!available && harness === 'codex' && driver.id === 'queue') unavailableReason = 'queue_missing';
    } else {
      state = 'unavailable';
      unavailableReason = process.platform === 'win32' && driver.id === 'terminal' ? 'windows' : 'driver_missing';
    }
    rows.push({ harness, rung: driver.rung, ...wakeStatusText(driver.id, state, unavailableReason) });
  }
  return rows;
}
export function selectedWakeStatus(rows: WakeStatusRow[]): IdleWakeStatus {
  const row = rows.find(item => item.state === 'active') ?? rows[0]!;
  const { driver, state, reason, remedy } = row;
  return { driver, state, reason, ...(remedy ? { remedy } : {}) };
}
export const WAKE_HARNESSES = HARNESS_REGISTRY.map(row => row.id);

export async function wakeDisableNotice(dir: string): Promise<string | undefined> {
  const { takeWakeDisableNotices } = await import('./shared/nonce');
  let drivers: string[];
  try {
    const states = await readWakeState(dir);
    if (!Object.values(states).some(state => state.disabled && !state.noticeShown)) return undefined;
    drivers = await takeWakeDisableNotices(dir);
  } catch { return undefined; } // Diagnostics cannot suppress message delivery.
  return drivers.length ? drivers.map(driver => {
    const status = wakeStatusText(driver, 'disabled_after_failures');
    return `Idle wake (${driver}): ${status.reason} Run \`${status.remedy}\` to re-enable it.`;
  }).join('\n') : undefined;
}
