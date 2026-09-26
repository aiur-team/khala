// The real `khala internal` launcher as a child process, for the probe families that
// need what only the launcher composes: the Claude session route, and the channel
// discovery routes with their transport, discovery and human roles. The launcher
// runs `run-internal.ts`, and the agent CLI runs in this worker exactly as
// `cli/main.ts` composes it against the launcher's files.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect } from 'vitest';
import { runCli } from '../../../packages/agent-cli/src/cli/app';
import { createClaudeSessionClient } from '../../../packages/agent-cli/src/composition/claude-session-http';
import { createInternalClient } from '../../../packages/agent-cli/src/composition/internal';
import { createUnavailableClient } from '../../../packages/agent-cli/src/composition/unavailable';
import { REPO_ROOT } from './inventory';

const RUNNER = path.join(REPO_ROOT, 'tests/e2e/security/run-internal.ts');

const cleanups: Array<() => Promise<void> | void> = [];

/** Stops every launcher and removes its state; call from `afterEach`. */
export async function closeLaunchers(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export type Reply = Readonly<{ status: number; headers: IncomingHttpHeaders; body: string }>;

export function call(origin: string, input: Readonly<{ method?: string; path: string; headers?: Record<string, string>; body?: unknown }>): Promise<Reply> {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const request = httpRequest({
      host: '127.0.0.1', port: Number(port), method: input.method ?? 'GET', path: input.path, agent: false,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        ...input.headers,
      },
    });
    request.once('error', reject);
    request.once('response', response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.end(body);
  });
}

export type Discovered = Readonly<{ principal: string; descriptorPath: string; discoveryCapability: string }>;

export type LauncherWorld = Readonly<{
  origin: string;
  /** The launch's `active.json`, carrying the transport capability. */
  descriptorPath: string;
  transportCapability: string;
  /** Everything the launcher processes wrote to stdout and stderr. */
  output(): string;
  owner: Record<string, string>;
  own: string;
  other: string;
  say(channel: string, body: string): Promise<void>;
  /** Tool results of `khala mcp-serve` as the Claude plugin launches it for one session, in call order. */
  serve(sessionId: string, calls: ReadonlyArray<readonly [string, Record<string, unknown>?]>): Promise<string[]>;
  /** `khala claude <op> --session <id>` as a Claude hook or the `/khala` skill runs it. */
  op(sessionId: string, op: string, stdin?: string): Promise<string>;
  /** `khala internal discovery` for one harness session, run by the real internal runtime. */
  discover(sessionId: string): Promise<Discovered>;
  /** `khala --internal-descriptor <path> <args>` as installed, stdout and stderr together. */
  khala(descriptorPath: string, args: readonly string[]): Promise<Readonly<{ code: number; out: string }>>;
  /** The owner's pending channel requests, as the owner's browser reads them. */
  ownerRequests(): Promise<Array<{ requestHandle: string; revision: string; outcome: string }>>;
}>;

type Report = Readonly<{ url: string; origin: string; channelId: string; descriptorPath: string }>;

/**
 * Runs one `khala internal` command as its own process. The e2e runner cannot resolve
 * the agent CLI's `khala-source` exports that the internal runtime imports, and a real
 * process is closer to what ships anyway. A long-running command reports its first line.
 */
function runInternal(state: string, command: unknown): Readonly<{ child: ChildProcess; stdout: () => string; stderr: () => string }> {
  const child = spawn(process.execPath, ['--no-warnings', '--conditions=khala-source', '--import', 'tsx', RUNNER, JSON.stringify(command)], {
    cwd: path.join(REPO_ROOT, 'apps/internal'),
    env: { ...process.env, XDG_STATE_HOME: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function firstLine(run: ReturnType<typeof runInternal>): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (!run.stdout().includes('\n')) {
    if (run.child.exitCode !== null) throw new Error(`khala internal exited ${run.child.exitCode}: ${run.stderr()}`);
    if (Date.now() > deadline) throw new Error(`khala internal did not report: ${run.stderr()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return run.stdout().split('\n')[0]!;
}

export async function launched(): Promise<LauncherWorld> {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kha138-launcher-'));
  fs.chmodSync(state, 0o700);
  cleanups.push(() => fs.rmSync(state, { recursive: true, force: true }));
  const outputs: Array<ReturnType<typeof runInternal>> = [];
  const launcher = runInternal(state, { kind: 'create' });
  outputs.push(launcher);
  const report = JSON.parse(await firstLine(launcher)) as Report & { kind: string };
  expect(report.kind).toBe('running');
  const transportCapability = (JSON.parse(fs.readFileSync(report.descriptorPath, 'utf8')) as { transportCapability: string }).transportCapability;
  const fragment = new URLSearchParams(new URL(report.url).hash.slice(1));
  const session = await call(report.origin, {
    method: 'POST', path: '/__khala/session', headers: { origin: report.origin },
    body: { credential: fragment.get('credential'), channelId: report.channelId },
  });
  expect(session.status).toBe(200);
  const owner = {
    cookie: String(session.headers['set-cookie']![0]).split(';')[0]!,
    'x-khala-request-secret': (JSON.parse(session.body) as { requestSecret: string }).requestSecret,
    origin: report.origin,
  };

  const created = await call(report.origin, { method: 'POST', path: '/api/v1/channels', headers: owner, body: { operationId: 'kha138-other', title: 'Other' } });
  expect(created.status).toBe(201);
  const other = (JSON.parse(created.body) as { channel: { channelId: string } }).channel.channelId;
  let txn = 0;

  return {
    origin: report.origin,
    descriptorPath: report.descriptorPath,
    transportCapability,
    output: () => outputs.map(run => run.stdout() + run.stderr()).join(''),
    owner,
    own: report.channelId,
    other,
    async say(channel, body) {
      const sent = await call(report.origin, {
        method: 'POST', path: `/api/v1/channels/${encodeURIComponent(channel)}/messages`, headers: owner,
        body: { clientTxnId: `kha138-${++txn}`, content: { v: 1, kind: 'text', body } },
      });
      expect(sent.status, sent.body).toBeLessThan(300);
    },
    async serve(sessionId, calls) {
      const stdout = new PassThrough();
      let out = '';
      stdout.on('data', chunk => { out += chunk; });
      const lines = calls.map(([name, args], index) => JSON.stringify({
        jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args ?? {} },
      }));
      const code = await runCli(['mcp-serve'], {
        client: createUnavailableClient(),
        inbox: async () => { throw new Error('the Claude MCP server never opens inbox storage'); },
        claude: createClaudeSessionClient({ descriptorPath: report.descriptorPath }),
        stdin: Readable.from([lines.map(line => `${line}\n`).join('')]), stdout, stderr: new PassThrough(),
        env: { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId },
      } as never);
      expect(code).toBe(0);
      const responses = out.split('\n').filter(Boolean);
      expect(responses).toHaveLength(calls.length);
      return responses;
    },
    async op(sessionId, op, stdin = '') {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = '';
      stdout.on('data', chunk => { out += chunk; });
      stderr.on('data', chunk => { out += chunk; });
      await runCli(['claude', op, '--session', sessionId], {
        client: createUnavailableClient(),
        inbox: async () => { throw new Error('`khala claude` never opens inbox storage'); },
        claude: createClaudeSessionClient({ descriptorPath: report.descriptorPath }),
        stdin: Readable.from([stdin]), stdout, stderr, env: {},
      } as never);
      return out;
    },
    async discover(sessionId) {
      const run = runInternal(state, { kind: 'discovery', harness: 'codex', sessionId, displayLabel: null, workspaceLabel: null });
      outputs.push(run);
      const issued = JSON.parse(await firstLine(run)) as { ok: boolean; principal: string; descriptorPath: string };
      expect(issued.ok, run.stderr()).toBe(true);
      const { discoveryCapability } = JSON.parse(fs.readFileSync(issued.descriptorPath, 'utf8')) as { discoveryCapability: string };
      return { principal: issued.principal, descriptorPath: issued.descriptorPath, discoveryCapability };
    },
    async khala(descriptorPath, args) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = '';
      stdout.on('data', chunk => { out += chunk; });
      stderr.on('data', chunk => { out += chunk; });
      const code = await runCli(['--internal-descriptor', descriptorPath, ...args], {
        client: createUnavailableClient(),
        listeningMode: null,
        inbox: async () => { throw new Error('an unjoined agent has no inbox'); },
        stdin: Readable.from(['']), stdout, stderr, env: {}, cwd: state,
        internalClient: async (descriptor: string) => createInternalClient({ descriptorPath: descriptor }),
      } as never);
      return { code, out };
    },
    async ownerRequests() {
      const inbox = await call(report.origin, { path: '/api/human/channel-requests', headers: owner });
      expect(inbox.status).toBe(200);
      return (JSON.parse(inbox.body) as { requests: Array<{ requestHandle: string; revision: string; outcome: string }> }).requests;
    },
  };
}
