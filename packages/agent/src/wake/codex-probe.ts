import { execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { scrubbedQueueEnv } from './idle-wake-process';

export type CodexQueueProbe = Readonly<{ available: boolean; reason?: string; command?: string }>;
const execute = promisify(execFile);
// Process-local cache: an update (including a symlink target change) probes again.
const probes = new Map<string, { mtime: number; result: Promise<CodexQueueProbe> }>();
export async function probeCodexQueue(env: NodeJS.ProcessEnv): Promise<CodexQueueProbe> {
  let command: string | undefined;
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      const candidate = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      command = await realpath(candidate);
      break;
    } catch { /* Try the next PATH entry. */ }
  }
  if (!command) return { available: false, reason: 'codex_binary_missing' };
  let mtime: number;
  try { mtime = (await stat(command)).mtimeMs; }
  catch { return { available: false, reason: 'codex_binary_missing' }; }
  const cached = probes.get(command);
  if (cached?.mtime === mtime) return cached.result;
  const binary = command;
  const result = (async (): Promise<CodexQueueProbe> => {
    let probeHome: string | undefined;
    try {
      probeHome = await mkdtemp(path.join(os.tmpdir(), 'khala-codex-probe-'));
      const { stdout } = await execute(binary, ['queue', '--help'], {
        env: { ...scrubbedQueueEnv(env), HOME: probeHome, CODEX_HOME: probeHome,
          XDG_CONFIG_HOME: probeHome, XDG_DATA_HOME: probeHome, XDG_STATE_HOME: probeHome }, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
      });
      return /--thread\b/.test(stdout) && /--message\b/.test(stdout)
        ? { available: true, command: binary }
        : { available: false, reason: 'codex_queue_unavailable' };
    } catch { return { available: false, reason: 'codex_queue_unavailable' }; }
    finally { if (probeHome) await rm(probeHome, { recursive: true, force: true }); }
  })();
  probes.set(binary, { mtime, result });
  return result;
}
