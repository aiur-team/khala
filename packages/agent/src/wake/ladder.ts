import path from 'node:path';
import { readListeningMode } from '../mode';
import { readActivity } from '../activity';
import { listChannels, type ChannelRef } from '../channels';
import { readCursor, unread, type Cursor } from '../inbox';
import { stateRoot } from '../state';
import type { WakeDriver, WakeDriverContext } from './driver';
import { driverAllowed, newNonce, wakeLine, recordAttempt, settleAttempts, readWakeState } from './shared';
import type { Activity } from '../activity';
import { readJson, SESSION_ID_PATTERN, type SessionFiles } from '../state';


export type WakeLadderDeps = Readonly<{
  files: SessionFiles;
  harness: string;
  sessionId: string;
  drivers: readonly WakeDriver[];
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  retryAfterMs?: number;
  now?: () => number;
  stderr?: (line: string) => void;
  warningPrefix?: string;
}>;
export type WakeLadder = Readonly<{ notify(): void; stop(): Promise<void> }>;

export function createWakeLadder(deps: WakeLadderDeps): WakeLadder {
  if (!SESSION_ID_PATTERN.test(deps.sessionId)) throw new TypeError('invalid_session_id');
  const now = deps.now ?? Date.now;
  const stderr = deps.stderr ?? (line => { process.stderr.write(line); });
  const controller = new AbortController();
  let pending: { at: number } | undefined;
  const wakesAtCount = new Map<string, number>();
  const identities = new Map<string, string>();
  const disabledDrivers = new Set<string>();
  let stopped = false;
  let again = false;
  let inFlight: Promise<void> | undefined;
  // Diagnostics must not turn a timer callback into an unhandled rejection.
  const warn = (warning: string, status?: string) => {
    try { stderr(JSON.stringify({ ok: false, warning, ...(status ? { status } : {}) }) + '\n'); }
    catch { /* A closed diagnostic stream does not stop cleanup. */ }
  };
  const evaluate = async () => {
    try {
      if (deps.drivers.some(driver => driver.verification !== 'none')) await settleAttempts(deps.files.dir, { now: now(), activity: await readActivity(deps.files) });
      const driverStates = await readWakeState(deps.files.dir);
      for (const [id, state] of Object.entries(driverStates)) {
        if (state.disabled && !disabledDrivers.has(id)) {
          disabledDrivers.add(id);
          // A replacement rung gets its own two-attempt budget for this delivery.
          wakesAtCount.clear();
          pending = undefined;
        }
      }
      const channels = await listChannels(deps.files);
      const eligible: { channel: ChannelRef; counts: { messages: number }; cursor: Cursor }[] = [];
      const currentIdentities = new Map<string, string>();
      for (const channel of channels) {
        const session = await readJson<{ roomId: string; userId: string }>(channel.files.session);
        const metadata = channel.legacy ? null : await readJson<{ joinedAt?: string }>(path.join(channel.files.dir, 'channel.json'));
        currentIdentities.set(channel.key, JSON.stringify([session?.roomId ?? channel.roomId, session?.userId, metadata?.joinedAt]));
        if (await readListeningMode(channel.files) === 'async') continue;
        eligible.push({ channel,
          counts: { messages: (await unread(channel.files)).entries.filter(entry => entry.kind === 'message' && entry.sender !== session?.userId).length }, cursor: await readCursor(channel.files) });
      }
      const keys = new Set(currentIdentities.keys());
      const changed = new Set<string>();
      for (const [key, identity] of currentIdentities) {
        if (identities.get(key) !== identity) changed.add(key);
      }
      for (const key of identities.keys()) if (!keys.has(key)) changed.add(key);
      // Preserve projections for unaffected channels when a membership/identity changes.
      // An empty rejoined A must not renew the budget earned by unread B.
      if (changed.size) {
        for (const [key, wakes] of [...wakesAtCount]) {
          const pairs = JSON.parse(key) as [string, number][];
          if (!pairs.some(([id]) => changed.has(id))) continue;
          wakesAtCount.delete(key);
          const remainingPairs = pairs.filter(([id]) => !changed.has(id));
          if (!remainingPairs.length) continue;
          const remaining = JSON.stringify(remainingPairs);
          wakesAtCount.set(remaining, Math.max(wakes, wakesAtCount.get(remaining) ?? 0));
        }
      }
      for (const key of changed) identities.delete(key);
      for (const [key, identity] of currentIdentities) identities.set(key, identity);
      const pairs = eligible.map(({ channel, cursor }) => [channel.key, cursor.deliveredCount] as [string, number])
        .sort(([a], [b]) => a.localeCompare(b));
      const budgetKey = JSON.stringify(pairs);
      if (changed.size) {
        const inheritedKey = JSON.stringify(pairs.filter(([key]) => !changed.has(key)));
        const newUnread = eligible.some(item => changed.has(item.channel.key) && item.counts.messages > 0);
        wakesAtCount.set(budgetKey, newUnread ? 0 : wakesAtCount.get(inheritedKey) ?? 0);
        if (newUnread || !eligible.some(item => !changed.has(item.channel.key) && item.counts.messages > 0)) pending = undefined;
      }
      if (!eligible.some(item => item.counts.messages > 0)) { pending = undefined; return; }
      const activity = await readActivity(deps.files);
      if (pending && Date.parse(activity.updatedAt) > pending.at) pending = undefined;
      const at = now();
      if (pending && at - pending.at < (deps.retryAfterMs ?? 60_000)) return;
      if (stopped || activity.state !== 'idle') return;
      const wakes = wakesAtCount.get(budgetKey) ?? 0;
      if (wakes >= 2) return;
      for (const { channel } of eligible) {
        if (await readListeningMode(channel.files) === 'async') { pending = undefined; return; }
      }
      if (stopped) return;
      const ctx: WakeDriverContext = { files: deps.files, harness: deps.harness, sessionId: deps.sessionId, env: deps.env ?? process.env, signal: controller.signal, now: at };
      const driver = await chooseWakeDriver(deps.drivers, ctx, activity);
      if (!driver || stopped) return;
      const stillEligible = async () => {
        if (stopped) return false;
        if (!await driverAllowed(stateRoot(ctx.env), ctx.harness, driver.id, driver.optIn)) return false;
        if ((await readWakeState(deps.files.dir))[driver.id]?.disabled) return false;
        for (const { channel } of eligible) {
          if (await readListeningMode(channel.files) === 'async') return false;
        }
        const current = await readActivity(deps.files);
        return !stopped && current.state === 'idle' && current.updatedAt === activity.updatedAt;
      };
      if (!await stillEligible()) return;
      const attemptAt = now();
      const nonce = newNonce();
      if (driver.verification !== 'none') {
        await recordAttempt(deps.files.dir, { nonce, driver: driver.id, at: attemptAt, deadline: attemptAt + (driver.rung === 1 ? 30_000 : 10_000), activityUpdatedAt: activity.updatedAt });
        if (!await stillEligible()) {
          // No transport was used; void the journal entry rather than count a failure.
          await settleAttempts(deps.files.dir, { now: now(), activity: await readActivity(deps.files), promptText: '' });
          return;
        }
      }
      if (stopped) return;
      pending = { at: attemptAt };
      wakesAtCount.set(budgetKey, wakes + 1);
      await driver.wake({ ...ctx, now: attemptAt }, wakeLine(nonce));
    } catch { warn(`${deps.warningPrefix ?? 'wake'}_waker_error`); }
  };
  const notify = () => {
    if (stopped) return;
    if (inFlight) { again = true; return; }
    inFlight = (async () => {
      do {
        again = false;
        await evaluate();
      } while (again && !stopped);
    })().finally(() => {
      inFlight = undefined;
      if (again && !stopped) notify();
    });
  };
  const timer = setInterval(notify, deps.pollMs ?? 1000);
  timer.unref();
  return {
    notify,
    async stop() {
      stopped = true;
      again = false;
      clearInterval(timer);
      controller.abort();
      await inFlight;
    },
  };
}

/** Select the first available rung; consent and per-session disable precede probing. */
export async function chooseWakeDriver(drivers: readonly WakeDriver[], ctx: WakeDriverContext, activity: Activity): Promise<WakeDriver | undefined> {
  if (activity.state !== 'idle') return undefined;
  const states = await readWakeState(ctx.files.dir);
  const override = ctx.env.KHALA_WAKE_TEST_IDLE_MS;
  const idleOverride = override !== undefined && /^\d+$/.test(override) ? Number(override) : undefined;
  for (const driver of [...drivers].sort((a, b) => a.rung - b.rung)) {
    if (states[driver.id]?.disabled) continue;
    if (!await driverAllowed(stateRoot(ctx.env), ctx.harness, driver.id, driver.optIn)) continue;
    if (!await driver.available(ctx)) continue;
    if (ctx.now - Date.parse(activity.updatedAt) < (idleOverride ?? driver.minIdleMs)) return undefined;
    return driver;
  }
  return undefined;
}
