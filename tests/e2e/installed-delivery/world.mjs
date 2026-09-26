// The world the installed-delivery suite drives: a synthetic machine set up by the packed
// `@aiur/khala` tarball, the installed `khala internal` running on it, the owner's own
// browser session against that launch, and every harness entry exactly as its harness
// config names it. Nothing here imports Khala source: the only Khala code that runs is
// what the tarball installed and what setup wrote into each harness's config.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { confirmed, createMachine, installHarness, khala, machineEnvironment } from '../../integration/agent-setup/harness.mjs';

/** The harness versions each fake answers `--version` with: the ones setup supports today. */
export const VERSIONS = Object.freeze({
  claude: '2.1.283 (Claude Code)',
  codex: 'codex-cli 0.154.0',
  opencode: '1.17.10',
  // `cursor --version` prints the version, the commit, then the architecture.
  cursor: '1.7.44\n9f3a2c1d\nx64',
});

/** A step failure that names the harness whose installed entry failed it. */
export class DeliveryFailure extends Error {
  constructor(harness, step, cause) {
    super(`[${harness}] ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.harness = harness;
  }
}

/** Runs `step` and rethrows any failure as that harness's `DeliveryFailure`. */
export async function step(harness, name, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DeliveryFailure) throw error;
    throw new DeliveryFailure(harness, name, error);
  }
}

export async function eventually(read, done, { timeoutMs = 10_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)?.slice(0, 400)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** A machine with every harness Khala installs for, set up by the installed package. */
export function setUpMachine(install) {
  const machine = createMachine();
  for (const [name, version] of Object.entries(VERSIONS)) installHarness(machine, name, version);
  const { plan, applied } = confirmed(install, machine, 'setup');
  if (applied === null || applied.status !== 0) throw new Error(`setup did not apply: ${plan.stdout}${plan.stderr}${applied?.stderr ?? ''}`);
  const status = khala(install, machine, ['status']);
  return { machine, status: status.json.configuration };
}

// ---------------------------------------------------------------------------
// The installed `khala internal` and the owner's session against it.

const LAUNCH_TIMEOUT_MS = 20_000;

/**
 * `khala internal` from the installed package, as a person runs it: the owner server for
 * one new channel, running until stopped. The machine's PATH holds no browser opener,
 * so the launch prints its URL and opens nothing.
 */
export async function startInternal(install, machine) {
  const child = spawn(process.execPath, [install.bin, 'internal'], {
    cwd: machine.cwd, env: machineEnvironment(machine), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  let status = null;
  void exited.then(code => { status = code; });
  const report = await eventually(() => (stdout.includes('\n') ? JSON.parse(stdout.split('\n')[0]) : status), value => value !== null && typeof value === 'object',
    { timeoutMs: LAUNCH_TIMEOUT_MS, what: 'khala internal to report' }).catch(error => {
    child.kill('SIGKILL');
    throw new Error(`${error.message}; exit ${status}; stderr ${stderr}`);
  });
  if (report.ok !== true || report.kind !== 'running') throw new Error(`khala internal did not start: ${stdout}${stderr}`);
  const owner = await ownerSession(report);
  return {
    report,
    owner,
    channelUrl: `${report.origin}/channels/${report.channelId}`,
    async stop() {
      if (status === null) child.kill('SIGINT');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(deadline);
    },
  };
}

async function reply(response) {
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

/** Redeems the printed bootstrap URL exactly as the owner's browser does. */
async function ownerSession(report) {
  const { origin, channelId } = report;
  const fragment = new URLSearchParams(new URL(report.url).hash.slice(1));
  const response = await fetch(`${origin}/__khala/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ credential: fragment.get('credential'), channelId: fragment.get('channel') }),
  });
  if (response.status !== 200) throw new Error(`bootstrap exchange failed: ${response.status}`);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  const { requestSecret } = await response.json();
  const call = async (pathname, init = {}) => reply(await fetch(`${origin}${pathname}`, {
    method: init.method ?? 'GET',
    headers: {
      cookie, origin, 'x-khala-request-secret': requestSecret,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }));
  const channel = `/api/v1/channels/${encodeURIComponent(channelId)}`;
  let posted = 0;
  return {
    call,
    /** The owner's pending access requests, as their inbox lists them. */
    async pending() {
      const inbox = await call('/api/human/channel-requests');
      if (inbox.status !== 200) throw new Error(`owner inbox answered ${inbox.status}`);
      return inbox.json.requests.filter(entry => entry.outcome === 'pending_owner');
    },
    /** The owner approves the one pending request, from `harness`, in their own UI. */
    async approve(harness) {
      const pending = await this.pending();
      if (pending.length !== 1) throw new Error(`expected one pending request, found ${pending.length}`);
      const [{ requestHandle, revision, requester }] = pending;
      if (requester.harness !== harness) throw new Error(`the pending request came from ${requester.harness}, not ${harness}`);
      const decided = await call(`/api/human/channel-access-requests/${requestHandle}/decision`, {
        method: 'POST',
        body: { v: 1, requestHandle, expectedRevision: revision, decision: 'approve', operationId: `decide-${requestHandle.slice(-8)}` },
      });
      if (decided.status !== 200) throw new Error(`owner approval answered ${decided.status}: ${decided.text}`);
    },
    /** The owner posts one message to the channel. */
    async say(body) {
      posted += 1;
      const sent = await call(`${channel}/messages`, {
        method: 'POST', body: { clientTxnId: `txn-installed-${String(posted).padStart(4, '0')}`, content: { v: 1, kind: 'text', body } },
      });
      if (sent.status !== 201) throw new Error(`owner message answered ${sent.status}: ${sent.text}`);
      return sent.json.event.eventId;
    },
    async bindings() {
      const listed = await call(`${channel}/bindings`);
      if (listed.status !== 200) throw new Error(`owner bindings answered ${listed.status}`);
      return listed.json.bindings;
    },
    async timeline() {
      return JSON.stringify((await call(`${channel}/timeline`)).json);
    },
    /** The channel events the owner's receipts show an agent acknowledged. */
    async acknowledgedEvents() {
      const receipts = await call(`${channel}/receipts`);
      if (receipts.status !== 200) throw new Error(`owner receipts answered ${receipts.status}: ${receipts.text}`);
      return receipts.json.facts
        .filter(fact => fact.receipt.kind === 'agent_acknowledged')
        .flatMap(fact => fact.events.map(event => event.eventId));
    },
    /** The owner's Stop: revokes every binding and ends delivery. */
    async stopAll() {
      const stopped = await call(`${channel}/stop`, { method: 'POST', body: { v: 1, targets: null } });
      if (stopped.status !== 200) throw new Error(`owner Stop answered ${stopped.status}: ${stopped.text}`);
      return stopped.json;
    },
  };
}

// ---------------------------------------------------------------------------
// Installed entries, read back from each harness's own config.

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * The Claude plugin as Claude Code loads it: the marketplace `~/.claude/settings.json`
 * registers, its enabled `khala` plugin, that plugin's `.mcp.json` server and its hooks,
 * with `${CLAUDE_PLUGIN_ROOT}` left for the shell, as Claude Code runs them.
 */
export function claudeEntries(machine) {
  const settings = readJson(path.join(machine.home, '.claude', 'settings.json'));
  if (settings.enabledPlugins?.['khala@khala'] !== true) throw new Error('the khala plugin is not enabled in ~/.claude/settings.json');
  const marketplace = settings.extraKnownMarketplaces.khala.source.path;
  const pluginRoot = path.join(marketplace, 'plugins', 'khala');
  const server = readJson(path.join(pluginRoot, '.mcp.json')).mcpServers.khala;
  const hooks = Object.fromEntries(Object.entries(readJson(path.join(pluginRoot, 'hooks', 'hooks.json')).hooks)
    .map(([event, groups]) => [event, groups.flatMap(group => group.hooks)]));
  return { pluginRoot, mcp: { command: server.command, args: server.args ?? [], env: server.env ?? {} }, hooks };
}

/** Codex's `mcp_servers.khala` from `~/.codex/config.toml` and its `hooks.json` handlers. */
export function codexEntries(machine) {
  const codex = path.join(machine.home, '.codex');
  const server = parseToml(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8')).mcp_servers.khala;
  const hooks = Object.fromEntries(Object.entries(readJson(path.join(codex, 'hooks.json')).hooks)
    .map(([event, groups]) => [event, groups.flatMap(group => group.hooks)]));
  return { mcp: { command: server.command, args: server.args ?? [], env: server.env ?? {} }, hooks };
}

/** OpenCode's `plugin` entry (a `file://` module URL) and `mcp.khala` from its config. */
export function openCodeEntries(machine) {
  const config = readJson(path.join(machine.home, '.config', 'opencode', 'opencode.json'));
  const plugins = config.plugin.filter(entry => entry.endsWith('/opencode.js'));
  if (plugins.length !== 1) throw new Error(`expected one Khala plugin entry, found ${JSON.stringify(config.plugin)}`);
  const [command, ...args] = config.mcp.khala.command;
  return { plugin: plugins[0], mcp: { command, args, env: config.mcp.khala.environment ?? {} } };
}

/** Cursor's global `~/.cursor/mcp.json` `khala` server. */
export function cursorEntries(machine) {
  const server = readJson(path.join(machine.home, '.cursor', 'mcp.json')).mcpServers.khala;
  return { mcp: { command: server.command, args: server.args ?? [], env: server.env ?? {} } };
}

// ---------------------------------------------------------------------------
// Running entries as their harness runs them.

/**
 * One MCP stdio session with an installed entry: spawned directly, command and args as
 * written, with the entry's env over the machine's. Requests are answered by id.
 */
export function mcpSession(machine, entry, extraEnv = {}) {
  const child = spawn(entry.command, entry.args, {
    env: { ...machineEnvironment(machine), ...entry.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  child.stdin.on('error', () => {});
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map();
  let failure = null;
  const fail = error => {
    failure ??= error;
    for (const { reject } of waiting.values()) reject(failure);
    waiting.clear();
  };
  child.once('error', error => fail(new Error(`MCP entry ${entry.command} did not start: ${error.code ?? error.message}`)));
  child.once('exit', (code, signal) => fail(new Error(`MCP entry exited ${code ?? signal}: ${stderr.trim()}`)));
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = waiting.get(message.id);
      if (pending) { waiting.delete(message.id); pending.resolve(message); }
    }
  });
  const request = (method, params, timeoutMs = 15_000) => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${method} within ${timeoutMs} ms: ${stderr.trim()}`)); }, timeoutMs);
      waiting.set(id, {
        resolve: message => { clearTimeout(timer); resolve(message); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  return {
    stderr: () => stderr,
    async initialize() {
      const answer = await request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-delivery', version: '0' },
      });
      if (answer.error) throw new Error(`initialize failed: ${JSON.stringify(answer.error)}`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return answer.result;
    },
    async tools() {
      const answer = await request('tools/list', {});
      if (answer.error) throw new Error(`tools/list failed: ${JSON.stringify(answer.error)}`);
      return answer.result.tools.map(tool => tool.name);
    },
    /** One `tools/call`; `meta` is the `_meta` the harness sends with it. Resolves the whole result. */
    async call(name, args = {}, meta) {
      const answer = await request('tools/call', { ...(meta === undefined ? {} : { _meta: meta }), name, arguments: args });
      if (answer.error) throw new Error(`${name} failed: ${JSON.stringify(answer.error)}`);
      return answer.result;
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    },
  };
}

/**
 * OpenCode running the installed plugin for one session: `opencode-host.mjs` imports the
 * `plugin` entry's URL in a process with the machine's environment, and the executable
 * path of OpenCode `version`, the path the plugin reads the running version from.
 */
export async function openCodeSession(machine, pluginUrl, { sessionId, version }) {
  const execPath = path.join(machine.root, 'opencode', 'versions', 'opencode', version, 'opencode');
  const child = spawn(process.execPath, [path.join(here, 'opencode-host.mjs'), pluginUrl, execPath, machine.cwd, sessionId], {
    env: machineEnvironment(machine), stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  const prompts = [];
  const waiting = new Map();
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  let loaded;
  const ready = new Promise((resolve, reject) => { loaded = { resolve, reject }; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  void exited.then(code => {
    const error = new Error(`the OpenCode host exited ${code}: ${stderr.trim()}`);
    loaded.reject(error);
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.event === 'prompt') prompts.push(message);
      else if (message.event === 'loaded') loaded.resolve(message.tools);
      else if (message.event === 'failed') loaded.reject(new Error(`the OpenCode plugin did not load: ${message.error}`));
      else {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.ok) pending?.resolve(message.result); else pending?.reject(new Error(message.error));
      }
    }
  });
  const request = body => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`OpenCode host did not answer ${JSON.stringify(body)}`)); }, 15_000);
    waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
  });
  const tools = await ready;
  return {
    tools,
    prompts,
    tool: (name, args = {}) => request({ op: 'tool', name, args }),
    /** A plugin hook, as OpenCode fires it for this session. */
    afterTool: tool => request({ op: 'hook', name: 'tool.execute.after', input: { tool, sessionID: sessionId } }),
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** The text a tool result carries, joined. */
export const resultText = result => (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

/**
 * One hook handler, run through `sh -c` as Claude Code and Codex run a command hook, with
 * the event's JSON on stdin and EOF. Its own process group, so a detached helper stops too.
 */
export async function runHook(machine, command, input, { env = {}, timeoutMs = 10_000 } = {}) {
  const child = spawn('/bin/sh', ['-c', command], {
    env: { ...machineEnvironment(machine), ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  child.stdin.on('error', () => {});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  const code = await exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** The installed `khala` bin, run as an agent's shell tool runs it. */
export function agentCli(install, machine, args) {
  const result = khala(install, machine, args);
  let json = result.json;
  if (json === undefined) { try { json = JSON.parse(result.stderr); } catch { /* not JSON */ } }
  return { ...result, json };
}

export const here = path.dirname(fileURLToPath(import.meta.url));
