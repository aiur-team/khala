import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { INTERNAL_ACTIVE_DESCRIPTOR_FILE, parseInternalDescriptor } from '@khala/contracts/internal/descriptor';

// Real processes: two launchers and one unrelated, independently started CLI
// stand-in. Nothing here is faked except the web bundle (a fixture).

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const harness = fileURLToPath(new URL('./fixtures/run-launcher.ts', import.meta.url));
const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateHome(): string {
  const root = fs.mkdtempSync(path.join('/tmp', 'khala-launcher-process-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

type Run = Readonly<{ child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<number | null> }>;

function start(state: string, args: readonly string[]): Run {
  const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', harness, ...args], {
    cwd: packageDirectory,
    env: { ...process.env, XDG_STATE_HOME: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

async function report(run: Run): Promise<Record<string, unknown> & { channelId: string; origin: string; port: number; descriptorPath: string }> {
  const deadline = Date.now() + 20_000;
  while (!run.stdout().includes('\n')) {
    if (run.child.exitCode !== null) throw new Error(`launcher exited ${run.child.exitCode}: ${run.stderr()}`);
    if (Date.now() > deadline) throw new Error(`launcher did not report: ${run.stderr()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return JSON.parse(run.stdout().split('\n')[0]!);
}

function reachable(origin: string): Promise<boolean> {
  const { port } = new URL(origin);
  return new Promise(resolve => {
    const request = httpRequest({ host: '127.0.0.1', port: Number(port), path: '/', headers: { host: `127.0.0.1:${port}` } });
    request.once('error', () => resolve(false));
    request.once('response', response => { response.resume(); resolve(true); });
    request.end();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('internal launcher processes', () => {
  it('refuses a second launcher at the root lease even with a free port, leaving active.json and user CLIs untouched', async () => {
    const state = stateHome();
    const launcherA = start(state, ['create', '-', '0']);
    const a = await report(launcherA);
    const active = path.join(state, 'khala', 'internal', INTERNAL_ACTIVE_DESCRIPTOR_FILE);
    expect(a.descriptorPath).toBe(active);
    const before = fs.readFileSync(active);

    // An independently started "agent CLI": Khala must never signal it.
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(sentinel);
    await new Promise(resolve => sentinel.once('spawn', resolve));

    // B asks for A's port, so the next port is free and a lease-blind launcher would fall forward and start.
    const launcherB = start(state, ['create', '-', String(a.port)]);
    const outcome = await Promise.race([
      launcherB.exited.then(code => ({ exited: code })),
      report(launcherB).then(started => ({ started })),
    ]);
    expect(outcome).toEqual({ exited: 3 });
    expect(JSON.parse(launcherB.stderr().trim().split('\n').at(-1)!)).toEqual({ ok: false, error: 'launcher_running' });
    expect(launcherB.stdout()).toBe('');
    expect(fs.readFileSync(active).equals(before)).toBe(true);
    expect(fs.readdirSync(path.join(state, 'khala', 'internal', 'channels'))).toHaveLength(1);
    expect(alive(sentinel.pid!)).toBe(true);
    expect(await reachable(a.origin)).toBe(true);

    // SIGTERM stops only the owner server: discovery goes, the URL dies, the sentinel lives.
    launcherA.child.kill('SIGTERM');
    expect(await launcherA.exited).toBe(0);
    expect(fs.existsSync(active)).toBe(false);
    expect(await reachable(a.origin)).toBe(false);
    expect(alive(sentinel.pid!)).toBe(true);
  }, 60_000);

  it('create -> SIGINT -> resume reaches the same channel through a new server generation', async () => {
    const state = stateHome();
    const first = start(state, ['create', '-', '0']);
    const created = await report(first);
    const firstDescriptor = fs.readFileSync(created.descriptorPath, 'utf8');
    first.child.kill('SIGINT');
    expect(await first.exited).toBe(0);
    expect(await reachable(created.origin)).toBe(false);

    const second = start(state, ['resume', created.channelId, '0']);
    const resumed = await report(second);
    expect(resumed.channelId).toBe(created.channelId);
    expect(await reachable(resumed.origin)).toBe(true);
    const descriptor = parseInternalDescriptor(fs.readFileSync(resumed.descriptorPath, 'utf8'));
    const previous = parseInternalDescriptor(firstDescriptor);
    expect(descriptor.ok && previous.ok && descriptor.value.transportCapability !== previous.value.transportCapability).toBe(true);
    second.child.kill('SIGTERM');
    expect(await second.exited).toBe(0);
  }, 60_000);

  it('a crashed launcher leaves no lease behind; the next launcher recovers stale discovery', async () => {
    const state = stateHome();
    const crashed = start(state, ['create', '-', '0']);
    const first = await report(crashed);
    crashed.child.kill('SIGKILL');
    await crashed.exited;
    // SIGKILL skips cleanup, so discovery is stale until the next owner takes the lease.
    expect(fs.existsSync(first.descriptorPath)).toBe(true);

    const next = start(state, ['resume', first.channelId, '0']);
    const resumed = await report(next);
    const descriptor = parseInternalDescriptor(fs.readFileSync(resumed.descriptorPath, 'utf8'));
    expect(descriptor.ok && descriptor.value.origin).toBe(resumed.origin);
    next.child.kill('SIGTERM');
    expect(await next.exited).toBe(0);
  }, 60_000);
});
