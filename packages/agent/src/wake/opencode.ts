import path from 'node:path';
import { readActivity } from '../activity';
import { listChannels } from '../channels';
import { readCursor, unread } from '../inbox';
import { readListeningMode } from '../mode';
import { readJson, writeJsonAtomic, stateRoot, type SessionFiles } from '../state';
import type { WakeDriver } from './driver';
import { createWakeLadder } from './ladder';
import type { HookIO } from '../harness/deliver-core';
import { withWakeLock } from './shared/lock';
import { driverAllowed, readWakeState, newNonce, wakeLine, recordAttempt, settleAttempts } from './shared';

const file = 'opencode-wake.json';
type Signal = { line: string; at: number; budget: string; attempts: number; delivered: boolean; channels?: string[] };
async function budget(files: SessionFiles): Promise<string> {
  const pairs = await Promise.all((await listChannels(files)).map(async channel =>
    [channel.key, (await readCursor(channel.files)).deliveredCount] as const));
  return JSON.stringify(pairs.sort(([a], [b]) => a.localeCompare(b)));
}
const canAttempt = (prior: Signal | null, key: string, now: number) => !prior || prior.budget !== key
  || (now - prior.at >= 60_000 && prior.attempts < 2);

/** The plugin polls through the CLI; the MCP process only publishes a wake signal. */
export const opencodeWakeDriver: WakeDriver = {
  id: 'opencode-native', rung: 1, optIn: false, minIdleMs: 0, deadlineMs: 3_000, verification: 'nonce',
  async available(ctx) {
    const prior = await readJson<Signal>(path.join(ctx.files.dir, file));
    return canAttempt(prior, await budget(ctx.files), ctx.now);
  },
  async wake(ctx, line) {
    return withWakeLock(ctx.files.dir, 'opencode-native.lock', async () => {
      if (ctx.signal.aborted || (await readActivity(ctx.files)).state !== 'idle') return 'skipped' as const;
      const key = await budget(ctx.files);
      const prior = await readJson<Signal>(path.join(ctx.files.dir, file));
      if (!canAttempt(prior, key, ctx.now)) return 'skipped' as const;
      const channels: string[] = [];
      for (const channel of await listChannels(ctx.files)) {
        if (await readListeningMode(channel.files) !== 'async') channels.push(channel.key);
      }
      await writeJsonAtomic(path.join(ctx.files.dir, file), { line, at: ctx.now, budget: key,
        attempts: prior?.budget === key ? prior.attempts + 1 : 1, delivered: false, channels });
    });
  },
};

export async function pollOpenCodeWake(files: SessionFiles, io: HookIO, replay = false): Promise<string | undefined> {
  if (replay) return withWakeLock(files.dir, 'opencode-native.lock', async () => {
    const pending = await readJson<Signal>(path.join(files.dir, file));
    const activity = await readActivity(files);
    await settleAttempts(files.dir, { now: io.now().getTime(), activity });
    if (!pending || activity.state !== 'idle'
      || !await driverAllowed(stateRoot(io.env), 'opencode', opencodeWakeDriver.id, false)
      || (await readWakeState(files.dir))[opencodeWakeDriver.id]?.disabled) return;
    const channels = (await listChannels(files)).filter(channel => !pending.channels || pending.channels.includes(channel.key));
    if (!channels.length) return;
    for (const channel of channels) if (await readListeningMode(channel.files) === 'async') return;
    const nonce = newNonce(), at = io.now().getTime();
    await recordAttempt(files.dir, { nonce, driver: opencodeWakeDriver.id, at,
      deadline: at + opencodeWakeDriver.deadlineMs, activityUpdatedAt: activity.updatedAt });
    const line = wakeLine(nonce);
    await writeJsonAtomic(path.join(files.dir, file), { ...pending, line, at });
    return line;
  });
  const ladder = createWakeLadder({ files, harness: 'opencode', sessionId: path.basename(files.dir),
    drivers: [opencodeWakeDriver], env: io.env, now: () => io.now().getTime(), stderr: text => io.stderr.write(text) });
  try { await ladder.poll(); } finally { await ladder.stop(); }
  return withWakeLock(files.dir, 'opencode-native.lock', async () => {
    const pending = await readJson<Signal>(path.join(files.dir, file));
    if (!pending || pending.delivered || io.now().getTime() > pending.at + opencodeWakeDriver.deadlineMs
      || pending.budget !== await budget(files) || (await readActivity(files)).state !== 'idle'
      || !await driverAllowed(stateRoot(io.env), 'opencode', opencodeWakeDriver.id, false)
      || (await readWakeState(files.dir))[opencodeWakeDriver.id]?.disabled) return;
    let eligible = false;
    for (const channel of await listChannels(files)) {
      if (await readListeningMode(channel.files) === 'async') continue;
      const session = await readJson<{ userId: string }>(channel.files.session);
      if ((await unread(channel.files)).entries.some(entry => entry.kind === 'message' && entry.sender !== session?.userId)) eligible = true;
    }
    if (!eligible) return;
    await writeJsonAtomic(path.join(files.dir, file), { ...pending, delivered: true });
    return pending.line;
  });
}
