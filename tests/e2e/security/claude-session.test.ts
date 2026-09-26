// U2: the Claude plugin's session path (KHA-133 wiring, #382) never carries content the
// session was not released.
//
// This family runs the real internal launcher, so its composition is the shipped one:
// the Claude session route admits the launch's transport capability from
// `active.json`, a session binds only through its own journaled access request and the
// owner's decision, and `khala mcp-serve` / `khala claude <op>` reach it through the
// same client `cli/main.ts` composes. The `pending` canary sits in a second owner
// channel no Claude session is granted; the `approved` canary sits in the granted
// session's own channel. An unbound bystander session must carry neither.
//
// In this build the Claude adapter refuses every `pull` and `read` as `unproven`: no
// acknowledgement route is proven and internal mode composes no listening-mode store
// (#382, `composition/claude-session/compose.ts`). So no message body reaches a Claude
// session at all, and the approved canary cannot serve as a positive control. The
// suite asserts that refusal exactly: the day reads are enabled it fails, and the
// approved-canary control must be switched on here. Until then the proof that the
// probes reached a real binding is that the granted session's own sends land in its
// channel, and only there.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../packages/agent-cli/src/cli/app';
import { CLAUDE_SESSION_PATH, createClaudeSessionClient } from '../../../packages/agent-cli/src/composition/claude-session-http';
import { createUnavailableClient } from '../../../packages/agent-cli/src/composition/unavailable';
import { type Canary, type SurfaceCapture, createSurfaceCapture, describeLeaks, mintCanary } from './fixtures';
import { REPO_ROOT, surfacesFor } from './inventory';

const RUNNER = path.join(REPO_ROOT, 'tests/e2e/security/run-internal.ts');
const GRANTED = 'session-granted';
const BYSTANDER = 'session-bystander';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Reply = Readonly<{ status: number; headers: IncomingHttpHeaders; body: string }>;

function call(origin: string, input: Readonly<{ method?: string; path: string; headers?: Record<string, string>; body?: unknown }>): Promise<Reply> {
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

type World = Readonly<{
  origin: string;
  descriptorPath: string;
  /** Everything the launcher process wrote to stdout and stderr. */
  output(): string;
  owner: Record<string, string>;
  own: string;
  other: string;
  say(channel: string, body: string): Promise<void>;
  /** Tool results of `khala mcp-serve` as the Claude plugin launches it for one session, in call order. */
  serve(sessionId: string, calls: ReadonlyArray<readonly [string, Record<string, unknown>?]>): Promise<string[]>;
  /** `khala claude <op> --session <id>` as a Claude hook or the `/khala` skill runs it. */
  op(sessionId: string, op: string, stdin?: string): Promise<string>;
}>;

type Report = Readonly<{ url: string; origin: string; channelId: string; descriptorPath: string }>;

/**
 * Starts `khala internal` as its own process. The e2e runner cannot resolve the agent
 * CLI's `khala-source` exports that the Claude session composition imports, and a real
 * process is closer to what ships anyway.
 */
async function startLauncher(state: string): Promise<Readonly<{ report: Report; child: ChildProcess; output: () => string }>> {
  const child = spawn(process.execPath, ['--no-warnings', '--conditions=khala-source', '--import', 'tsx', RUNNER], {
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
  const deadline = Date.now() + 30_000;
  while (!stdout.includes('\n')) {
    if (child.exitCode !== null) throw new Error(`launcher exited ${child.exitCode}: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`launcher did not report: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const report = JSON.parse(stdout.split('\n')[0]!) as Report & { kind: string };
  expect(report.kind).toBe('running');
  return { report, child, output: () => stdout + stderr };
}

async function launched(): Promise<World> {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kha138-claude-'));
  fs.chmodSync(state, 0o700);
  cleanups.push(() => fs.rmSync(state, { recursive: true, force: true }));
  const { report, output } = await startLauncher(state);
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
    output,
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
  };
}

async function approvePending(world: World): Promise<void> {
  const inbox = await call(world.origin, { path: '/api/human/channel-requests', headers: world.owner });
  expect(inbox.status).toBe(200);
  const pending = (JSON.parse(inbox.body) as { requests: Array<{ requestHandle: string; revision: string; outcome: string }> }).requests
    .filter(entry => entry.outcome === 'pending_owner');
  expect(pending).toHaveLength(1);
  const { requestHandle, revision } = pending[0]!;
  const decided = await call(world.origin, {
    method: 'POST', path: `/api/human/channel-access-requests/${requestHandle}/decision`, headers: world.owner,
    body: { v: 1, requestHandle, expectedRevision: revision, decision: 'approve', operationId: `decide-${requestHandle.slice(-8)}` },
  });
  expect(decided.status).toBe(200);
}

type Seeded = Readonly<{ world: World; pending: Canary; approved: Canary; operationId: string; capture: SurfaceCapture }>;

/** A granted session in the launch channel, an unbound bystander, and canaries on both sides. */
async function seeded(): Promise<Seeded> {
  const world = await launched();
  const pending = mintCanary('pending');
  const approved = mintCanary('approved');
  await world.say(world.other, `before ${pending.text}`);
  const [requested] = await world.serve(GRANTED, [['khala_request_channel_access', { target: `${world.origin}/channels/${encodeURIComponent(world.own)}` }]]);
  const operationId = (JSON.parse(requested!) as { result: { structuredContent: { operationId: string } } }).result.structuredContent.operationId;
  await approvePending(world);
  const [status] = await world.serve(GRANTED, [['khala_channel_access_status', { operationId }]]);
  expect(status).toContain('"outcome":"connected"');
  await world.say(world.own, `released ${approved.text}`);
  await world.say(world.other, `after ${pending.text}`);
  return { world, pending, approved, operationId, capture: createSurfaceCapture() };
}

function toolArguments(tool: string, seed: Seeded, sessionId: string): Record<string, unknown> {
  const other = `${seed.world.origin}/channels/${encodeURIComponent(seed.world.other)}`;
  switch (tool) {
    case 'khala_send': return { message: `probe from the Claude tool ${sessionId}` };
    case 'khala_request_channel_access': return { target: other };
    case 'khala_channel_access_status': return { operationId: seed.operationId };
    case 'khala_create_channel': return { title: 'Probe', operationId: 'create-13800000' };
    case 'khala_read': case 'khala_status': case 'khala_list_channels': case 'khala_list_agents': return {};
    default: throw new Error(`claude-session: no arguments defined for ${tool}; add a probe for it`);
  }
}

/** Drives every inventoried surface of the family for one session; returns the IDs driven. */
async function driveFamily(seed: Seeded, sessionId: string): Promise<string[]> {
  const listed = surfacesFor('claude-session');
  const tools = listed.filter(id => id.startsWith('claude-mcp-tool:')).map(id => id.slice('claude-mcp-tool:'.length));
  const ops = listed.filter(id => id.startsWith('claude-op:')).map(id => id.slice('claude-op:'.length));
  const routes = listed.filter(id => id.startsWith('http-internal:'));
  expect(routes).toEqual([`http-internal:POST ${CLAUDE_SESSION_PATH}`]);
  expect(listed.length).toBe(tools.length + ops.length + routes.length);
  // Hooks first: `pull` never acknowledges, so the agent's own reads still see the release afterwards.
  for (const op of ops) seed.capture.add(`claude-op:${op} ${sessionId}`, await seed.world.op(sessionId, op, `probe from the Claude op ${sessionId}`));
  const results = await seed.world.serve(sessionId, tools.map(tool => [tool, toolArguments(tool, seed, sessionId)] as const));
  tools.forEach((tool, index) => seed.capture.add(`claude-mcp-tool:${tool} ${sessionId}`, results[index]!));
  // The route itself, with the session's own credential path covered above: the owner session and a forged bearer.
  const request = { v: 1, op: 'read', sessionId };
  const asOwner = await call(seed.world.origin, { method: 'POST', path: CLAUDE_SESSION_PATH, headers: seed.world.owner, body: request });
  expect(asOwner.status).toBe(403);
  const forged = await call(seed.world.origin, { method: 'POST', path: CLAUDE_SESSION_PATH, headers: { authorization: `Bearer ${'A'.repeat(42)}E` }, body: request });
  expect(forged.status).toBe(401);
  seed.capture.add(`http-internal:POST ${CLAUDE_SESSION_PATH} ${sessionId}`, asOwner.body + forged.body);
  return [...tools.map(tool => `claude-mcp-tool:${tool}`), ...ops.map(op => `claude-op:${op}`), ...routes];
}

/** The owner's timeline of `channel`, as the owner's browser reads it. */
async function timeline(world: World, channel: string): Promise<string> {
  const read = await call(world.origin, { path: `/api/v1/channels/${encodeURIComponent(channel)}/timeline`, headers: world.owner });
  expect(read.status).toBe(200);
  return read.body;
}

describe('Claude session surfaces never carry content the session was not released', () => {
  it('claude-session: every Claude tool, op and the session route, for a granted and an unbound session', async () => {
    const seed = await seeded();
    const driven = await driveFamily(seed, GRANTED);
    await driveFamily(seed, BYSTANDER);
    expect(driven.sort()).toEqual([...surfacesFor('claude-session')].sort());
    // The launcher process's own output is a server log.
    seed.capture.add('launcher-output', seed.world.output());

    const leaks = seed.capture.leaks([seed.pending, seed.approved]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
    // Why the approved canary is absent too: reads are refused, not filtered.
    const granted = (surface: string) => seed.capture.text(`${surface} ${GRANTED}`);
    for (const surface of ['claude-op:pull', 'claude-op:read', 'claude-mcp-tool:khala_read']) {
      expect(granted(surface), surface).toContain('"code":"unproven"');
    }
    for (const surface of ['claude-op:hook', 'claude-op:mode', 'claude-mcp-tool:khala_status']) {
      expect(granted(surface), surface).toContain('"code":"unavailable"');
    }
  });

  it('the granted binding is real: its sends reach its own channel only, and the bystander\'s reach nothing', async () => {
    const seed = await seeded();
    await driveFamily(seed, GRANTED);
    await driveFamily(seed, BYSTANDER);
    const own = await timeline(seed.world, seed.world.own);
    const other = await timeline(seed.world, seed.world.other);
    expect(own).toContain(`probe from the Claude tool ${GRANTED}`);
    expect(own).toContain(`probe from the Claude op ${GRANTED}`);
    expect(other).not.toContain('probe from the Claude');
    expect(own + other).not.toContain(BYSTANDER);
    expect(seed.capture.text(`claude-mcp-tool:khala_list_agents ${GRANTED}`)).toContain('"ownerDisplayName":"Owner"');
  });
});
