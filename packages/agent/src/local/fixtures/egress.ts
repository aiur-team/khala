import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export type EgressRecord =
  | { v: 1; pid: number; kind: 'guard'; event: 'installed'; argv: string[]; node: string }
  | { v: 1; pid: number; kind: 'guard'; event: 'no_module_hooks' }
  | { v: 1; pid: number; kind: 'tcp'; host: string; port: number; allowed: boolean }
  | { v: 1; pid: number; kind: 'udp'; host: string; port: number; allowed: boolean }
  | { v: 1; pid: number; kind: 'ipc'; path: string; allowed: true }
  | { v: 1; pid: number; kind: 'dns'; fn: string; host: string; allowed: boolean }
  | { v: 1; pid: number; kind: 'module'; url: string };
export const guardUrl = new URL('../../../test/no-egress/guard.mjs', import.meta.url);
export const probePath = fileURLToPath(new URL('../../../test/no-egress/probe.mjs', import.meta.url));
export const driverPath = fileURLToPath(new URL('./no-egress-agents.ts', import.meta.url));
const binPath = fileURLToPath(new URL('../../../bin/khala.mjs', import.meta.url));
export function guardedEnv(log: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, NODE_OPTIONS: `--import=${guardUrl.href}`, KHALA_EGRESS_LOG: log };
}
export async function readEgressLog(log: string): Promise<EgressRecord[]> {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as EgressRecord);
}
export const nonLoopbackAttempts = (records: EgressRecord[]): EgressRecord[] => records.filter(record => 'allowed' in record && !record.allowed);
export const matrixModules = (records: EgressRecord[]): EgressRecord[] => records.filter(record => record.kind === 'module');
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
export type ProcessResult = { code: number | null; stdout: string; stderr: string; pid: number };
export function runNode(args: string[], env: NodeJS.ProcessEnv, stdin = ''): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'pipe' });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr, pid: child.pid! }); });
    child.stdin.end(stdin);
  });
}
export const runKhala = (args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> => runNode([binPath, 'local', ...args], env);
export async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < end);
  throw new Error('eventually_timeout');
}
export async function startHelper(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; exited: Promise<void>; stderr: () => string }> {
  const child = spawn(process.execPath, [binPath, 'local', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await eventually(async () => {
      if (spawnError || child.exitCode !== null) throw spawnError ?? new Error(`helper_exited: ${stderr}`);
      try { const response = await fetch(`http://127.0.0.1:${env.KHALA_LOCAL_PORT}/healthz`, { signal: AbortSignal.timeout(500) }); return (await response.json()).ok === true; }
      catch { return false; }
    });
    return { child, exited, stderr: () => stderr };
  } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
}
export async function stopHelper(helper: Awaited<ReturnType<typeof startHelper>>, env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  try { return await runKhala(['stop'], env); }
  finally {
    helper.child.kill('SIGTERM');
    const timeout = setTimeout(() => helper.child.kill('SIGKILL'), 2000);
    try { await helper.exited; } finally { clearTimeout(timeout); }
  }
}
