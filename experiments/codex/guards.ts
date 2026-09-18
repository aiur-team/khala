/**
 * Safety guards for the live driver. Pure, so each refusal is testable without a
 * model. The driver may only touch the one disposable thread the operator
 * designated; pointed at a real dormant thread it would append synthetic turns to
 * that thread's private history.
 */
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/** The only thread the operator authorized live cases against (issue #13, 2026-09-18T02:38Z). */
export const DISPOSABLE_THREAD_ID = '01a0b261-639c-7cf1-a6b0-f485ee08dfac';

export type Target = {
  threadId: string; workdir: string; rollout: string; priorMarker: string; scratchDir: string; outFile: string;
  /** Replay the same clientUserMessageId once after a disconnect. Off by default: it creates a duplicate. */
  replayProbe?: boolean;
};

export class TargetRefused extends Error {
  constructor(readonly reason: string) { super(`refusing target: ${reason}`); }
}

const within = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

export const disposableRoot = (home: string) => join(home, '.cache', 'khala-disposable');

/**
 * Refuse anything but the pinned disposable thread, a workdir under the disposable
 * root and that thread's own rollout. `realWorkdir` is the workdir after symlink
 * resolution, so a link out of the root is refused too.
 */
export function validateTarget(t: Target, home: string, realWorkdir: string = t.workdir): void {
  if (t.threadId !== DISPOSABLE_THREAD_ID) throw new TargetRefused('thread_not_designated');
  for (const [name, p] of [['workdir', t.workdir], ['rollout', t.rollout], ['scratchDir', t.scratchDir], ['outFile', t.outFile]] as const) {
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p) throw new TargetRefused(`${name}_not_normalized_absolute`);
  }
  const root = disposableRoot(home);
  if (!within(root, t.workdir) || !within(root, realWorkdir)) throw new TargetRefused('workdir_outside_disposable_root');
  const name = basename(t.rollout);
  if (!name.startsWith('rollout-') || !name.endsWith(`-${t.threadId}.jsonl`)) throw new TargetRefused('rollout_not_target');
  if (!within(join(home, '.codex', 'sessions'), t.rollout)) throw new TargetRefused('rollout_outside_sessions');
  if (typeof t.priorMarker !== 'string' || !/^prior-marker-[a-z0-9-]{1,64}$/.test(t.priorMarker)) throw new TargetRefused('prior_marker_invalid');
}

/** Another process holding the writer lock means the thread is live elsewhere. */
export function refuseIfHeld(lockHolder: number | null): void {
  if (lockHolder !== null) throw new TargetRefused('held_by_another_executor');
}

/** Native metadata must name the target thread and workdir before it is resumed. */
export function assertThreadMatches(thread: { id?: unknown; cwd?: unknown } | undefined, t: Target): void {
  if (thread?.id !== t.threadId) throw new TargetRefused('thread_id_mismatch');
  if (thread?.cwd !== t.workdir) throw new TargetRefused('thread_cwd_mismatch');
}

/** The writer lock must be held by a process in the executor group this driver spawned. */
export function spawnedLockHolder(lockHolder: number | null, spawnedGroup: readonly number[]): number {
  if (lockHolder === null || !spawnedGroup.includes(lockHolder)) throw new TargetRefused('lock_not_held_by_spawned_executor');
  return lockHolder;
}

/** Run the driver; on any failure stop every executor it spawned before rethrowing. */
export async function runWithCleanup<C, T>(run: () => Promise<T>, spawned: readonly C[], stop: (c: C) => Promise<unknown>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    await Promise.allSettled(spawned.map(stop));
    throw e;
  }
}
