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
import { adapterFor } from '../../harness';
import type { HarnessAdapter } from '../../harness/adapter';
import { conformanceDrivers } from '../../harness/conformance/drivers';
import type { FakeHarnessDriver, FakeSession, HookEvent } from '../../harness/conformance/driver';
import { listChannels } from '../../channels';
import { readEntries } from '../../inbox';
import { readListeningMode } from '../../mode';
import { readHelperFile } from '../lifecycle';
import { eventually, freePort, guardedEnv, readEgressLog, type ProcessResult } from './egress';

const bin = fileURLToPath(new URL('../../../bin/khala.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
export type ToolResult = { content: { type: string; text?: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };
export type HookFrame = { decision?: string; reason?: string; hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
export type World = {
  root: string; state: string; port: number; origin: string; log: string; env: NodeJS.ProcessEnv;
  guard: boolean; processGroups: Set<number>;
  claude: McpProcess; codex: McpProcess; probe?: McpProcess; agents: McpProcess[]; watchers: WakeWatcher[];
  browser?: Browser; browserTemp?: string; page?: Page; requests: string[]; blocked: string[];
};

// The recording lane is explicitly outside AE10; never inherit the runner's guard into it.
function runtimeEnv(world: World, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...world.env, ...extra };
  // Runner color settings must not add Node warnings to hook diagnostics.
  if (env.NO_COLOR !== undefined) env.FORCE_COLOR = undefined;
  if (world.guard) return guardedEnv(world.log, env);
  delete env.NODE_OPTIONS; delete env.KHALA_EGRESS_LOG;
  return env;
}
function trackGroup(world: World, child: ChildProcessWithoutNullStreams): void {
  if (!world.guard && child.pid) world.processGroups.add(child.pid);
}
function runRuntime(world: World, args: string[], stdin = '', extra: NodeJS.ProcessEnv = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: runtimeEnv(world, extra), stdio: 'pipe', detached: !world.guard });
    trackGroup(world, child);
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(new Error('runtime_stdin_failed')); });
    child.once('error', () => { clearTimeout(timeout); reject(new Error('runtime_spawn_failed')); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr, pid: child.pid! }); });
    child.stdin.end(stdin);
  });
}

export class McpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly files;
  stderr = '';
  readonly closed: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(readonly world: World, readonly adapter: HarnessAdapter, readonly driver: FakeHarnessDriver,
    readonly session: FakeSession, entrypoint = bin) {
    const harness = adapter.id as Harness; const sessionId = session.id;
    this.files = sessionFiles(harness, sessionId, { ...world.env, ...session.mcpEnv });
    this.child = spawn(process.execPath, [entrypoint, 'mcp', '--harness', harness], {
      env: runtimeEnv(world, session.mcpEnv), stdio: 'pipe', detached: !world.guard,
    });
    trackGroup(world, this.child);
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
  get harness(): Harness { return this.adapter.id as Harness; }
  get sessionId(): string { return this.session.id; }
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
  static async start(world: World, adapter: HarnessAdapter, driver: FakeHarnessDriver,
    session: FakeSession = driver.newSession(world.root), entrypoint?: string): Promise<McpProcess> {
    await driver.prepareSession?.(session, { ...world.env, ...session.mcpEnv });
    const agent = new McpProcess(world, adapter, driver, session, entrypoint); world.agents.push(agent);
    await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-acceptance', version: '1' } });
    agent.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await agent.rpc<{ tools?: { name: string }[] }>('tools/list', {});
    if (JSON.stringify(listed.tools?.map((tool: { name: string }) => tool.name)) !==
      JSON.stringify(['khala_join', 'khala_status', 'khala_read', 'khala_send', 'khala_leave', 'khala_event'])) {
      throw new Error('mcp_tool_set_changed');
    }
    return agent;
  }
  call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.rpc<ToolResult>('tools/call', { name, arguments: args, ...(this.session.mcpMeta ? { _meta: this.session.mcpMeta } : {}) });
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

export async function createWorld(options: { guard?: boolean } = {}): Promise<World> {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-local-e2e-'));
  const state = path.join(root, 'state'); const fakeBin = path.join(root, 'bin');
  await mkdir(state, { mode: 0o700 }); await mkdir(fakeBin, { mode: 0o700 });
  await writeFile(path.join(fakeBin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const calls = path.join(fakeBin, 'codex-calls.log');
  await writeFile(path.join(fakeBin, 'wake-calls.jsonl'), '', { mode: 0o600 });
  // Executables resolve their logs beside themselves, even under restricted wake envs.
  for (const command of ['codex', 'tmux', 'wezterm', 'kitten', 'python3']) {
    await writeFile(path.join(fakeBin, command), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = __dirname, command = path.basename(__filename), argv = process.argv.slice(2);
if (command === 'codex' && argv.join(' ') === 'queue --help') { console.log('--thread --message'); process.exit(0); }
fs.appendFileSync(path.join(root, 'wake-calls.jsonl'), JSON.stringify({ command, argv }) + '\\n');
if (command === 'codex') { fs.appendFileSync(path.join(root, 'codex-calls.log'), argv.join(' ') + '\\n'); process.exit(0); }
if (command !== 'tmux') process.exit(1);
const file = path.join(root, 'terminal.json');
if (!fs.existsSync(file)) process.exit(1);
const pane = JSON.parse(fs.readFileSync(file, 'utf8'));
const action = argv[0] === '-S' ? argv[2] : argv[0];
if (action === 'display-message') console.log([pane.pid, 0, 0, 2 + (pane.composer || '').length, 0, pane.tty, 0].join('|'));
else if (action === 'capture-pane') console.log('❯' + (pane.composer ? ' ' + pane.composer : ''));
else if (action === 'send-keys') {
  if (argv.includes('-l')) pane.composer = argv[argv.indexOf('-l') + 1];
  else if (argv.at(-1) === 'Enter') { pane.submitted = pane.composer; pane.composer = ''; }
  else process.exit(1);
  fs.writeFileSync(file, JSON.stringify(pane));
} else process.exit(1);
`, { mode: 0o755 });
  }
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
  const guard = options.guard !== false;
  const env = guardedEnv(log, { XDG_STATE_HOME: state, KHALA_LOCAL_PORT: String(port), KHALA_LOCAL_IDLE_MS: '600000',
    KHALA_LOCAL_WEB_DIR: webDir, USER: 'kevin', PATH: fakeBin + path.delimiter + process.env.PATH });
  if (!guard) { delete env.NODE_OPTIONS; delete env.KHALA_EGRESS_LOG; }
  const world = { guard, processGroups: new Set<number>(), root, state, port, origin: `http://127.0.0.1:${port}`, log, env, agents: [], watchers: [], requests: [], blocked: [] } as unknown as World;
  try {
    world.claude = await startAgent(world, 'claude', 'e2e-claude');
    world.codex = await startAgent(world, 'codex', 'e2e-codex');
    return world;
  } catch (error) { await cleanupWorld(world); throw error; }
}
/** Legacy acceptance identities use the same driver syntax as Tier B. */
export async function startAgent(world: World, harness: Harness, sessionId: string): Promise<McpProcess> {
  const driver = conformanceDrivers[harness]!;
  const sample = driver.newSession(world.root);
  const session = { ...sample, id: sessionId,
    mcpEnv: Object.fromEntries(Object.entries(sample.mcpEnv).map(([key, value]) => [key, value === sample.id ? sessionId : value])),
    ...(sample.mcpMeta ? { mcpMeta: Object.fromEntries(Object.entries(sample.mcpMeta).map(([key, value]) => [key, value === sample.id ? sessionId : value])) } : {}),
  };
  return McpProcess.start(world, adapterFor(harness)!, driver, session);
}
export async function cli(world: World, ...args: string[]) {
  const result = await runRuntime(world, [bin, 'local', ...args]);
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { data = undefined; }
  return { ...result, data };
}
export const inbox = async (agent: McpProcess) => (await Promise.all(
  (await listChannels(agent.files)).map(channel => readEntries(channel.files)))).flat();
export const mode = async (agent: McpProcess) => {
  const channels = await listChannels(agent.files);
  if (channels.length !== 1) throw new Error('expected_single_channel');
  return readListeningMode(channels[0]!.files);
};
export const helperFile = (world: World) => readHelperFile(world.env);
export async function codexCalls(world: World): Promise<string[]> {
  return (await readFile(path.join(world.root, 'bin/codex-calls.log'), 'utf8')).split('\n').filter(Boolean);
}
export async function wakeCalls(world: World): Promise<{ command: string; argv: string[] }[]> {
  return (await readFile(path.join(world.root, 'bin/wake-calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
/** Real PTY ownership plus a fake remote-control binary; no user terminal is touched. */
export async function prepareTmux(agent: McpProcess): Promise<void> {
  if (process.platform !== 'linux' || agent.world.guard) throw new Error('terminal_fixture_requires_unguarded_linux');
  const file = path.join(agent.world.root, 'bin/terminal.json');
  const source = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], JSON.stringify({pid: process.pid, tty: fs.readlinkSync('/proc/self/fd/0')})); setInterval(() => {}, 1000);`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  if (!existsSync(file)) {
  const child = spawn('script', ['-q', '-c', `stty raw -echo; exec ${quote(process.execPath)} -e ${quote(source)} ${quote(file)}`, '/dev/null'],
    { env: runtimeEnv(agent.world), stdio: 'pipe', detached: !agent.world.guard });
  trackGroup(agent.world, child); child.stdout.resume(); child.stderr.resume();
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  await eventually(async () => {
    if (spawnError || child.exitCode !== null) throw new Error('terminal_fixture_exited');
    return existsSync(file);
  });
  }
  const pane = JSON.parse(await readFile(file, 'utf8')) as { pid: number; tty: string };
  agent.world.processGroups.add(pane.pid);
  const { readProcess } = await import('../../harness/proc');
  const identity = await readProcess(pane.pid);
  if (!identity) throw new Error('terminal_fixture_exited');
  await writeFile(path.join(agent.files.dir, 'pane.json'), JSON.stringify({ kind: 'tmux', paneId: '%7',
    socket: path.join(agent.world.root, 'tmux.sock'), agentPid: pane.pid, agentStartTime: identity.startTime, capturedAt: new Date().toISOString() }));
}
export async function deliver(agent: McpProcess, event: 'PostToolUse' | 'UserPromptSubmit' | 'Stop', prompt?: string): Promise<HookFrame | null> {
  const result = await runRuntime(agent.world, [bin, 'hook', 'deliver', '--harness', agent.harness],
    agent.driver.hookStdin(({ PostToolUse: 'tool', UserPromptSubmit: 'prompt', Stop: 'stop' } as const)[event],
      { ...agent.session, ...(prompt !== undefined ? { promptText: prompt } : {}) }), agent.session.mcpEnv);
  if (result.code !== 0) throw new Error('deliver_failed');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
export async function hook(agent: McpProcess, event: HookEvent, extra: { continuation?: boolean; promptText?: string } = {}) {
  const result = await runRuntime(agent.world, [bin, 'hook', 'deliver', '--harness', agent.harness],
    agent.driver.hookStdin(event, { ...agent.session, ...extra }), agent.session.mcpEnv);
  if (result.code !== 0) throw new Error('deliver_failed');
  return agent.driver.readHookStdout(result.stdout.trim());
}
export type WakeWatcher = { child: ChildProcessWithoutNullStreams; exited: Promise<{ code: number | null; stderr: string }>; running: boolean; kill: () => void };
export async function armClaudeWake(agent: McpProcess): Promise<WakeWatcher> {
  const watcherFile = path.join(agent.files.dir, 'watcher.json');
  const previous = await readFile(watcherFile, 'utf8').catch(() => '');
  const child = spawn(process.execPath, [bin, 'hook', 'claude-wake'], { stdio: 'pipe', detached: !agent.world.guard, env: runtimeEnv(agent.world,
    { KHALA_WAKE_TEST_POLL_MS: '50', KHALA_WAKE_TEST_DEADLINE_MS: '15000' }) });
  trackGroup(agent.world, child);
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
  // Chromium's Unix socket path cannot fit the agent workspace's long TMPDIR.
  world.browserTemp = await mkdtemp('/tmp/ki160-1014-chromium-');
  world.browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    env: { ...process.env, TMPDIR: world.browserTemp, XDG_CONFIG_HOME: world.browserTemp },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'] });
  const context = await world.browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === world.origin) await route.continue();
    else { world.blocked.push(url); await route.abort(); }
  });
  context.on('request', request => world.requests.push(request.url()));
  await context.routeWebSocket('**/*', socket => {
    const address = new URL(socket.url());
    world.requests.push(socket.url());
    if (address.protocol === 'ws:' && address.host === new URL(world.origin).host) socket.connectToServer();
    else { world.blocked.push(socket.url()); socket.close({ code: 1008, reason: 'foreign_origin' }); }
  });
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
  const helper = await helperFile(world).catch(() => null);
  await cli(world, 'stop').catch(() => undefined);
  if (!world.guard) {
    if (helper) { try { process.kill(helper.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
    for (const group of world.processGroups) { try { process.kill(-group, 'SIGKILL'); } catch { /* Group exited. */ } }
  }
  const records = await readEgressLog(world.log).catch(() => []);
  for (const record of records) if (record.kind === 'guard' && record.event === 'installed' && record.argv.includes('serve')) {
    try { process.kill(record.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
  await world.browser?.close().catch(() => undefined);
  if (world.browserTemp) await rm(world.browserTemp, { recursive: true, force: true });
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
