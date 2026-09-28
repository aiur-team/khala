// Test-only provenance check for the already-running Codex Sol session used by
// the crash proof. This neither creates a session nor claims model consumption.
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export type NativeSolHandoff = Readonly<{
  sessionId: string;
  workdir: string;
  codexHome: string;
  preflightRoot: string;
  nativePid: number;
  nativeStartTime: string;
  preflightBindingId: string;
  preflightGeneration: number;
}>;

export type NativeSolHandoffResult =
  | Readonly<{ kind: 'ready'; pid: number; sessionId: string; bindingId: string; generation: number }>
  | Readonly<{ kind: 'blocked'; code: 'native_sol_handoff_unproven' }>;

const blocked = (): NativeSolHandoffResult => ({ kind: 'blocked', code: 'native_sol_handoff_unproven' });
const absolute = (value: unknown): value is string => typeof value === 'string'
  && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A past Sol turn cannot attest a session whose latest turn switched models. */
export function nativeSolRolloutMatches(rollout: string, sessionId: string, workdir: string): boolean {
  let sessionMeta = false;
  let latestTurn: Record<string, unknown> | null = null;
  for (const line of rollout.split('\n')) {
    if (!line) continue;
    let item: unknown;
    try { item = JSON.parse(line); } catch { return false; }
    if (!record(item) || !record(item.payload)) continue;
    if (item.type === 'session_meta') {
      if (item.payload.id !== sessionId || item.payload.cwd !== workdir
        || item.payload.cli_version !== '0.157.1') return false;
      sessionMeta = true;
    }
    if (item.type === 'turn_context') latestTurn = item.payload;
  }
  return sessionMeta && latestTurn?.model === 'gpt-6-sol' && latestTurn.cwd === workdir;
}

/** A private preflight binding is not the crash runner's separately minted binding. */
export async function inspectNativeSolHandoff(input: NativeSolHandoff): Promise<NativeSolHandoffResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(input.sessionId)
    || !absolute(input.workdir) || !absolute(input.codexHome) || !absolute(input.preflightRoot)
    || input.codexHome !== path.join(input.preflightRoot, 'codex-home')
    || !input.workdir.startsWith(input.preflightRoot + path.sep)
    || !Number.isSafeInteger(input.nativePid) || input.nativePid < 2
    || !/^[1-9][0-9]*$/u.test(input.nativeStartTime)
    || typeof input.preflightBindingId !== 'string' || !input.preflightBindingId
    || !Number.isSafeInteger(input.preflightGeneration) || input.preflightGeneration < 0) return blocked();

  try {
    const state = path.join(input.preflightRoot, 'state');
    const scopePath = path.join(state, 'scope.json');
    const bindingPath = path.join(state, 'binding.json');
    const [scopeStat, bindingStat, scopeText, bindingText] = await Promise.all([
      lstat(scopePath), lstat(bindingPath), readFile(scopePath, 'utf8'), readFile(bindingPath, 'utf8'),
    ]);
    const privateFile = (file: typeof scopeStat, maxSize: number) => file.isFile()
      && !file.isSymbolicLink() && file.uid === process.getuid?.()
      && (file.mode & 0o077) === 0 && file.size <= maxSize;
    if (!privateFile(scopeStat, 64 * 1024) || !privateFile(bindingStat, 64 * 1024)) return blocked();
    const scope: unknown = JSON.parse(scopeText);
    const binding: unknown = JSON.parse(bindingText);
    if (!record(scope) || !record(binding)
      || scope.nativePid !== input.nativePid || scope.nativeStartTime !== input.nativeStartTime
      || scope.sessionId !== input.sessionId || scope.codexHome !== input.codexHome
      || scope.fixtureRoot !== input.preflightRoot || !absolute(scope.cgroup)
      || !absolute(scope.nativeExecutable) || !scope.nativeExecutable.endsWith('/codex')
      || !absolute(scope.sessionFile)
      || binding.v !== 1 || binding.harness !== 'codex'
      || binding.sessionId !== input.sessionId
      || binding.bindingId !== input.preflightBindingId
      || binding.generation !== input.preflightGeneration) return blocked();

    const sourceStat = await lstat(scope.sessionFile);
    if (!privateFile(sourceStat, 4 * 1024 * 1024)) return blocked();
    const sessionFile = await realpath(scope.sessionFile);
    if (!sessionFile.startsWith(path.join(input.codexHome, 'sessions') + path.sep)
      || !sessionFile.endsWith('.jsonl')) return blocked();
    const rollout = await readFile(sessionFile, 'utf8');
    if (!nativeSolRolloutMatches(rollout, input.sessionId, input.workdir)) return blocked();

    const pid = input.nativePid;
    const [executable, cwd, statText, cgroupText, environment, argvBytes] = await Promise.all([
      readlink(`/proc/${pid}/exe`), readlink(`/proc/${pid}/cwd`), readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cgroup`, 'utf8'), readFile(`/proc/${pid}/environ`),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    const fields = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const argv = argvBytes.toString('utf8').split('\0').filter(Boolean);
    const env = environment.toString('utf8').split('\0');
    if (executable !== scope.nativeExecutable || cwd !== input.workdir
      || fields[0] === 'Z' || fields[19] !== input.nativeStartTime
      || !cgroupText.split('\n').some(line => line === `0::${scope.cgroup}`)
      || !env.includes(`CODEX_HOME=${input.codexHome}`)
      || !env.includes(`KHALA_42_SYNC_ROOT=${input.preflightRoot}`)
      || !argv.some((arg, index) => arg === '-m' && argv[index + 1] === 'gpt-6-sol')) return blocked();
    return { kind: 'ready', pid, sessionId: input.sessionId,
      bindingId: input.preflightBindingId, generation: input.preflightGeneration };
  } catch { return blocked(); }
}
