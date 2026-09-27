import { spawn, type ChildProcess } from 'node:child_process';
import type { NativeAcceptance } from './crash-boundary';

export type CrashObservation = Readonly<{ accepted: NativeAcceptance; signal: 'SIGKILL' }>;

function nativeAcceptance(value: unknown): value is NativeAcceptance {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<NativeAcceptance>;
  return item.kind === 'native_accepted'
    && typeof item.releaseId === 'string' && item.releaseId.length > 0
    && typeof item.bindingId === 'string' && item.bindingId.length > 0
    && Number.isSafeInteger(item.generation)
    && typeof item.sessionId === 'string' && item.sessionId.length > 0
    && item.receiptKind === 'harness_queued';
}

/**
 * The child owns the real connector and native session adapter. A queue receipt
 * from that adapter is the only signal accepted. The parent waits for the kernel
 * to reap the child before any ledger/profile restart or stale-lock repair.
 */
export async function killAtNativeAcceptance(input: Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  expectedReleaseId: string;
  expectedSessionId: string;
  timeoutMs?: number;
}>): Promise<CrashObservation> {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd, env: input.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    shell: false,
  });
  // Do not report child stderr: native process errors can include local paths.
  child.stderr?.resume();
  const timeoutMs = input.timeoutMs ?? 30_000;
  let accepted: NativeAcceptance | null = null;
  try {
    accepted = await new Promise<NativeAcceptance>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('native_acceptance_timeout')), timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const onMessage = (value: unknown) => {
        if (!nativeAcceptance(value)) return;
        cleanup();
        resolve(value);
      };
      const onError = () => { cleanup(); reject(new Error('native_child_start_failed')); };
      const onExit = () => { cleanup(); reject(new Error('native_child_exited_before_acceptance')); };
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    if (accepted.releaseId !== input.expectedReleaseId || accepted.sessionId !== input.expectedSessionId) {
      throw new Error('native_acceptance_identity_mismatch');
    }
    if (!child.kill('SIGKILL')) throw new Error('native_child_kill_failed');
    const exited = await awaitExit(child);
    if (exited.signal !== 'SIGKILL') throw new Error('native_child_not_killed');
    return { accepted, signal: 'SIGKILL' };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await awaitExit(child);
    }
  }
}

function awaitExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
