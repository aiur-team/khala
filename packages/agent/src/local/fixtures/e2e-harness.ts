import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { sessionFiles } from '../../state';
import { readEntries } from '../../inbox';
import { readListeningMode } from '../../mode';
import { readHelperFile } from '../lifecycle';
import { eventually, freePort, guardedEnv, readEgressLog, runKhala, runNode } from './egress';

const bin = fileURLToPath(new URL('../../../bin/khala.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
export type ToolResult = { content: { type: string; text?: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };
export type HookFrame = { decision?: string; reason?: string; hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
export type World = {
  root: string; state: string; port: number; origin: string; log: string; env: NodeJS.ProcessEnv;
  claude: McpProcess; codex: McpProcess; probe?: McpProcess; agents: McpProcess[]; watchers: WakeWatcher[];
  browser?: Browser; page?: Page; requests: string[]; blocked: string[];
};

export class McpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly files;
  stderr = '';
  readonly closed: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(readonly world: World, readonly harness: Harness, readonly sessionId: string) {
    this.files = sessionFiles(harness, sessionId, world.env);
    this.child = spawn(process.execPath, [bin, 'mcp', '--harness', harness], {
      env: guardedEnv(world.log, { ...world.env, CLAUDE_CODE_SESSION_ID: sessionId }), stdio: 'pipe',
    });
    this.child.stderr.setEncoding('utf8').on('data', chunk => { this.stderr += chunk; });
    let buffer = '';
    this.child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line); const waiter = this.pending.get(frame.id);
          if (!waiter) continue;
          clearTimeout(waiter.timer); this.pending.delete(frame.id);
          if (frame.error) waiter.reject(new Error('mcp_rpc_error')); else waiter.resolve(frame.result);
        } catch { this.fail(new Error('mcp_invalid_frame')); }
      }
    });
    this.child.stdin.on('error', () => this.fail(new Error('mcp_stdin_closed')));
    this.child.once('error', () => this.fail(new Error('mcp_spawn_failed')));
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(new Error('mcp_closed')); resolve(); }));
  }
  get pid(): number { return this.child.pid!; }
  private fail(error: Error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  private rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(new Error('mcp_closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('mcp_rpc_timeout')); }, 20_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  static async start(world: World, harness: Harness, sessionId: string): Promise<McpProcess> {
    const agent = new McpProcess(world, harness, sessionId); world.agents.push(agent);
    await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-acceptance', version: '1' } });
    agent.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await agent.rpc<{ tools?: { name: string }[] }>('tools/list', {});
    if (JSON.stringify(listed.tools?.map((tool: { name: string }) => tool.name)) !==
      JSON.stringify(['khala_join', 'khala_status', 'khala_read', 'khala_send', 'khala_event'])) {
      throw new Error('mcp_tool_set_changed');
    }
    return agent;
  }
  call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.rpc<ToolResult>('tools/call', { name, arguments: args, ...(this.harness === 'codex' ? { _meta: { threadId: this.sessionId } } : {}) });
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

export async function createWorld(): Promise<World> {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-local-e2e-'));
  const state = path.join(root, 'state'); const fakeBin = path.join(root, 'bin');
  await mkdir(state, { mode: 0o700 }); await mkdir(fakeBin, { mode: 0o700 });
  const calls = path.join(fakeBin, 'codex-calls.log');
  // Resolve the log relative to the executable: queue intentionally receives a restricted environment.
  await writeFile(path.join(fakeBin, 'codex'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$(dirname "$0")/codex-calls.log"\nexit 0\n', { mode: 0o755 });
  await writeFile(calls, '', { mode: 0o600 });
  const port = await freePort(); const log = path.join(root, 'egress.jsonl');
  await writeFile(log, '', { mode: 0o600 });
  const webDir = process.env.KHALA_LOCAL_WEB_DIR ?? path.join(repo, 'apps/web/dist-local');
  if (!existsSync(path.join(webDir, 'index.html')) && !process.env.KHALA_LOCAL_WEB_DIR) {
    const build = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('pnpm', ['--filter', '@khala/web', 'build:local'], { cwd: repo, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    if (build !== 0) { await rm(root, { recursive: true, force: true }); throw new Error('local_web_build_failed'); }
  }
  const env = guardedEnv(log, { XDG_STATE_HOME: state, KHALA_LOCAL_PORT: String(port), KHALA_LOCAL_IDLE_MS: '600000',
    KHALA_LOCAL_WEB_DIR: webDir, USER: 'kevin', PATH: fakeBin + path.delimiter + process.env.PATH });
  const world = { root, state, port, origin: `http://127.0.0.1:${port}`, log, env, agents: [], watchers: [], requests: [], blocked: [] } as unknown as World;
  try {
    world.claude = await McpProcess.start(world, 'claude', 'e2e-claude');
    world.codex = await McpProcess.start(world, 'codex', 'e2e-codex');
    return world;
  } catch (error) { await cleanupWorld(world); throw error; }
}
export async function cli(world: World, ...args: string[]) {
  const result = await runKhala(args, guardedEnv(world.log, world.env));
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { data = undefined; }
  return { ...result, data };
}
export const inbox = (agent: McpProcess) => readEntries(agent.files);
export const mode = (agent: McpProcess) => readListeningMode(agent.files);
export const helperFile = (world: World) => readHelperFile(world.env);
export async function codexCalls(world: World): Promise<string[]> {
  return (await readFile(path.join(world.root, 'bin/codex-calls.log'), 'utf8')).split('\n').filter(Boolean);
}
export async function deliver(agent: McpProcess, event: 'PostToolUse' | 'UserPromptSubmit' | 'Stop'): Promise<HookFrame | null> {
  const result = await runNode([bin, 'hook', 'deliver', '--harness', agent.harness], guardedEnv(agent.world.log, agent.world.env),
    JSON.stringify({ session_id: agent.sessionId, hook_event_name: event }));
  if (result.code !== 0) throw new Error('deliver_failed');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
export type WakeWatcher = { child: ChildProcessWithoutNullStreams; exited: Promise<{ code: number | null; stderr: string }>; running: boolean; kill: () => void };
export async function armClaudeWake(agent: McpProcess): Promise<WakeWatcher> {
  const watcherFile = path.join(agent.files.dir, 'watcher.json');
  const previous = await readFile(watcherFile, 'utf8').catch(() => '');
  const child = spawn(process.execPath, [bin, 'hook', 'claude-wake'], { stdio: 'pipe', env: guardedEnv(agent.world.log,
    { ...agent.world.env, KHALA_WAKE_TEST_POLL_MS: '50', KHALA_WAKE_TEST_DEADLINE_MS: '15000' }) });
  let stderr = ''; child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  child.stdin.on('error', () => {});
  const watcher: WakeWatcher = { child, running: true, kill: () => { child.kill('SIGTERM'); }, exited: Promise.resolve({ code: null, stderr: '' }) };
  watcher.exited = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('wake_spawn_failed')));
    child.once('close', code => { watcher.running = false; resolve({ code, stderr }); });
  });
  agent.world.watchers.push(watcher);
  child.stdin.end(JSON.stringify({ session_id: agent.sessionId, hook_event_name: 'Stop' }));
  await eventually(async () => !watcher.running || await readFile(watcherFile, 'utf8').catch(() => '') !== previous, 5000);
  if (!watcher.running) throw new Error('claude_wake_exited_before_armed');
  return watcher;
}
export type RawResponse = { status: number; headers: import('node:http').IncomingHttpHeaders; body: unknown };
export async function raw(world: World, options: { method: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ hostname: '127.0.0.1', port: world.port, path: options.path, method: options.method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers } }, res => {
      let text = ''; res.setEncoding('utf8').on('data', chunk => { text += chunk; });
      res.once('end', () => { let parsed: unknown = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* SPA HTML. */ }
        resolve({ status: res.statusCode!, headers: res.headers, body: parsed }); });
    });
    req.setTimeout(5000, () => req.destroy(new Error('http_timeout')));
    req.once('error', () => reject(new Error('local_http_failed'))); req.end(body);
  });
}
export async function admin(world: World, method: string, pathname: string, body?: unknown): Promise<RawResponse> {
  const file = await helperFile(world); if (!file) throw new Error('helper_file_missing');
  return raw(world, { method, path: pathname, body, headers: { authorization: `Bearer ${file.adminToken}` } });
}
export async function openBrowser(world: World): Promise<Page> {
  world.browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'] });
  const context = await world.browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === world.origin) await route.continue();
    else { world.blocked.push(url); await route.abort(); }
  });
  context.on('request', request => world.requests.push(request.url()));
  world.page = await context.newPage(); world.page.setDefaultTimeout(10_000); world.page.setDefaultNavigationTimeout(15_000);
  return world.page;
}
export async function ownerOpen(world: World, page: Page, name: string): Promise<void> {
  const result = await cli(world, 'open', name);
  const data = result.data as { openUrl?: unknown } | undefined;
  if (result.code !== 0 || typeof data?.openUrl !== 'string') throw new Error('owner_open_failed');
  const response = await page.goto(data.openUrl);
  if (response?.status() === 503) throw new Error('AE5 (KI-143): web_not_built');
}
export async function cleanupWorld(world: World): Promise<void> {
  for (const watcher of world.watchers) watcher.kill();
  await Promise.allSettled(world.agents.map(agent => agent.close()));
  await Promise.allSettled(world.watchers.map(watcher => watcher.exited));
  await cli(world, 'stop').catch(() => undefined);
  const records = await readEgressLog(world.log).catch(() => []);
  for (const record of records) if (record.kind === 'guard' && record.event === 'installed' && record.argv.includes('serve')) {
    try { process.kill(record.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
  await world.browser?.close().catch(() => undefined);
  if (process.env.KHALA_E2E_KEEP !== '1') await rm(world.root, { recursive: true, force: true });
}

/** Evidence excludes composer contents and any rendered capability links. */
export async function screenshot(world: World, name: string): Promise<void> {
  if (!world.page || !/^ae\d+-[a-z0-9-]+\.png$/.test(name)) throw new Error('invalid_screenshot');
  const directory = path.join(repo, 'packages/agent/test-results/local-e2e');
  await mkdir(directory, { recursive: true });
  await world.page.screenshot({ path: path.join(directory, name), fullPage: true, mask: [
    world.page.getByRole('combobox', { name: 'Message' }),
    world.page.locator('a[href*="/join/"], a[href*="/open/"]'),
    world.page.getByText(/http:\/\/127\.0\.0\.1:\d+\/(?:join|open)\/[A-Za-z0-9_-]{43}/),
  ] });
}
