import fs from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runCli } from '@aiur/khala/cli/app';
import { openInbox } from '@aiur/khala/cli/inbox';
import { createClaudeSessionClient } from '@aiur/khala/composition/claude-session-http';
import { createInternalClient } from '@aiur/khala/composition/internal';
import { createInternalDelivery } from '@aiur/khala/composition/internal-delivery';
import { createUnavailableClient } from '@aiur/khala/composition/unavailable';
import { INTERNAL_DISCOVERY_DIRECTORY } from '@khala/contracts/internal/discovery-descriptor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHook, sessionGranted } from '../../../../../packages/claude-plugin/hooks/lib/runtime.mjs';
import { webBundleManifest } from '../../launcher/bundle';
import { type LaunchReport, launchInternal } from '../../launcher/launcher';
import { channelDirectory } from '../../lifecycle/paths';
import { internalReleaseId } from '../../store/release-id';
import { discoveryPrincipal } from '../channel-discovery/service';
import { RECEIPT_LOG_FILE } from '../receipt-projection';
import { CLAUDE_GRANT_FILE, CLAUDE_SETTLE_INTERVAL_MS } from './compose';

// The Claude plugin's `mcp-serve` against the real internal launcher: the transport
// capability from `active.json`, the channel-access journal, the owner's decision in
// their own UI, and the journaled activation. Nothing here stands in for the grant.

const fixtureBundle = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'launcher', 'fixtures', 'internal-web');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Readonly<{ status: number; headers: IncomingMessage['headers']; json: any }>;

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
      response.once('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, json });
      });
    });
    request.end(body);
  });
}

type ToolResponse = { id: number; result?: { structuredContent: Record<string, unknown>; isError?: boolean }; error?: unknown };

/** The Claude Code version the tests' launcher inspects: installed, and not in the proven list. */
const INSTALLED_CLAUDE = '2.1.283';

/** A fresh launch, or with `resume` the same root and channel relaunched on the same port. */
async function launched(
  resume?: Readonly<{ parent: string; channelId: string; port: number }>,
  options: Readonly<{ clock?: () => number; claudeVersion?: () => Promise<string | null> }> = {},
) {
  const { clock, claudeVersion = async () => INSTALLED_CLAUDE } = options;
  const parent = resume?.parent ?? fs.mkdtempSync('/tmp/khala-claude-');
  if (resume === undefined) cleanups.push(() => fs.rmSync(parent, { recursive: true, force: true }));
  const outcome = await launchInternal({
    root: path.join(parent, 'internal'), assets: webBundleManifest(fixtureBundle),
    request: resume === undefined ? { kind: 'create' } : { kind: 'resume', channelId: resume.channelId },
    startPort: resume?.port ?? 0, claudeVersion,
    ...(clock === undefined ? {} : { clock }),
  });
  if (outcome.kind !== 'running') throw new Error(`launch failed: ${outcome.code}`);
  cleanups.push(() => outcome.shutdown());
  const report: LaunchReport = outcome.report;
  const fragment = new URLSearchParams(new URL(report.url).hash.slice(1));
  const session = await call(report.origin, {
    method: 'POST', path: '/__khala/session', headers: { origin: report.origin },
    body: { credential: fragment.get('credential'), channelId: report.channelId },
  });
  expect(session.status).toBe(200);
  const owner = {
    cookie: String(session.headers['set-cookie']![0]).split(';')[0]!,
    'x-khala-request-secret': session.json.requestSecret as string,
    origin: report.origin,
  };
  return { report, owner, channelUrl: `${report.origin}/channels/${report.channelId}`, parent, shutdown: outcome.shutdown };
}

/** `khala mcp-serve` exactly as the Claude plugin's MCP entry launches it for one session. */
async function serve(descriptorPath: string, sessionId: string, calls: ReadonlyArray<readonly [string, Record<string, unknown>?]>) {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', chunk => { out += chunk; });
  const lines = calls.map(([name, args], index) => JSON.stringify({
    jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args ?? {} },
  }));
  const code = await runCli(['mcp-serve'], {
    client: createUnavailableClient(),
    inbox: vi.fn(async () => { throw new Error('the Claude MCP server never opens inbox storage'); }),
    claude: createClaudeSessionClient({ descriptorPath }),
    stdin: Readable.from([lines.map(line => `${line}\n`).join('')]), stdout, stderr: new PassThrough(),
    env: { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId },
  });
  expect(code).toBe(0);
  const responses = out.split('\n').filter(Boolean).map(line => JSON.parse(line) as ToolResponse);
  return responses.map(response => response.result!.structuredContent);
}

/** `khala claude <op> --session <id>`, exactly as the plugin's hooks and `/khala` skill run it. */
async function claude(descriptorPath: string, op: string, sessionId: string): Promise<string> {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', chunk => { out += chunk; });
  await runCli(['claude', op, '--session', sessionId], {
    client: createUnavailableClient(),
    inbox: vi.fn(async () => { throw new Error('the Claude command never opens inbox storage'); }),
    claude: createClaudeSessionClient({ descriptorPath }),
    stdin: Readable.from([]), stdout, stderr: new PassThrough(),
  });
  return out;
}

async function approvePending(origin: string, owner: Record<string, string>): Promise<void> {
  const inbox = await call(origin, { path: '/api/human/channel-requests', headers: owner });
  expect(inbox.status).toBe(200);
  const pending = (inbox.json.requests as Array<{ requestHandle: string; revision: string; outcome: string; requester: { harness: string } }>)
    .filter(entry => entry.outcome === 'pending_owner');
  expect(pending).toHaveLength(1);
  expect(pending[0]!.requester.harness).toBe('claude');
  const { requestHandle, revision } = pending[0]!;
  const decided = await call(origin, {
    method: 'POST', path: `/api/human/channel-access-requests/${requestHandle}/decision`, headers: owner,
    body: { v: 1, requestHandle, expectedRevision: revision, decision: 'approve', operationId: `decide-${requestHandle.slice(-8)}` },
  });
  expect(decided.status).toBe(200);
}

describe('Claude mcp-serve against the internal launcher', () => {
  it('starts against the real server, and an unbound session gets the unbound answers', async () => {
    const { report } = await launched();
    const [send, who, read] = await serve(report.descriptorPath, 'session-alone', [
      ['khala_send', { message: 'hello' }], ['khala_list_agents'], ['khala_read'],
    ]);
    expect(send).toEqual({ kind: 'refused', code: 'session_not_bound' });
    expect(who).toEqual({ ok: false, error: 'not_joined' });
    expect(read).toEqual({ kind: 'refused', code: 'session_not_bound' });
  });

  it('admits only the launch transport capability on the Claude session route', async () => {
    const { report, owner } = await launched();
    const body = { v: 1, op: 'status', sessionId: 'session-any' };
    // The owner's browser session is a real principal, but not this route's.
    const asOwner = await call(report.origin, { method: 'POST', path: '/api/agent/claude/session', headers: owner, body });
    expect(asOwner.status).toBe(403);
    const forged = await call(report.origin, {
      method: 'POST', path: '/api/agent/claude/session', headers: { authorization: `Bearer ${'A'.repeat(42)}E` }, body,
    });
    expect(forged.status).toBe(401);
  });

  it('refuses an access request naming another origin, before anything is filed', async () => {
    const { report, owner, channelUrl } = await launched();
    const [refused] = await serve(report.descriptorPath, 'session-origin', [
      ['khala_request_channel_access', { target: channelUrl, origin: 'http://127.0.0.1:1' }],
    ]);
    expect(refused).toMatchObject({ ok: false, error: 'untrusted_origin' });
    const inbox = await call(report.origin, { path: '/api/human/channel-requests', headers: owner });
    expect(inbox.json.requests).toEqual([]);
  });

  it('shares one discovery identity between concurrent first calls of a new session', async () => {
    const { report, owner, channelUrl } = await launched();
    const session = 'session-racing';
    const [[listed], [requested]] = await Promise.all([
      serve(report.descriptorPath, session, [['khala_list_channels']]),
      serve(report.descriptorPath, session, [['khala_request_channel_access', { target: channelUrl }]]),
    ]);
    expect(listed).toMatchObject({ ok: true });
    expect(requested).toMatchObject({ ok: true, outcome: 'pending_owner' });
    // The request stays readable: no second issuance rotated the identity that filed it.
    const [status] = await serve(report.descriptorPath, session, [['khala_channel_access_status', { operationId: requested!.operationId }]]);
    expect(status).toMatchObject({ ok: true, outcome: 'pending_owner' });
    await approvePending(report.origin, owner);
  });

  it('binds a session to another channel the owner created, and lists that channel', async () => {
    const { report, owner } = await launched();
    const created = await call(report.origin, {
      method: 'POST', path: '/api/v1/channels', headers: owner, body: { operationId: 'second-channel', title: 'Second' },
    });
    expect(created.status).toBe(201);
    const second = created.json.channel.channelId as string;
    expect(second).not.toBe(report.channelId);
    const [requested] = await serve(report.descriptorPath, 'session-second', [
      ['khala_request_channel_access', { target: `${report.origin}/channels/${encodeURIComponent(second)}` }],
    ]);
    expect(requested).toMatchObject({ ok: true, outcome: 'pending_owner' });
    await approvePending(report.origin, owner);
    const [status, send, who] = await serve(report.descriptorPath, 'session-second', [
      ['khala_channel_access_status', { operationId: requested!.operationId }],
      ['khala_send', { message: 'hello second channel' }],
      ['khala_list_agents'],
    ]);
    expect(status).toMatchObject({ ok: true, outcome: 'connected' });
    expect(send).toMatchObject({ kind: 'accepted' });
    expect((who as { agents: unknown[] }).agents).toHaveLength(1);
    const timeline = async (channel: string) => JSON.stringify((await call(report.origin, {
      path: `/api/v1/channels/${encodeURIComponent(channel)}/timeline`, headers: owner,
    })).json);
    expect(await timeline(second)).toContain('hello second channel');
    expect(await timeline(report.channelId)).not.toContain('hello second channel');
  });

  it('files a create intent for the session through the journal, which reaches the owner and admits nothing', async () => {
    const { report, owner } = await launched();
    const create = ['khala_create_channel', { title: 'Launch plans', operationId: 'create-12345678' }] as const;
    const [created, retried, send] = await serve(report.descriptorPath, 'session-creator', [create, create, ['khala_send', { message: 'hello' }]]);
    expect(created).toEqual({ ok: true, v: 1, operationId: 'create-12345678', outcome: 'pending_owner', next: null });
    // A retry under the same operation reads the same request; it files no second one.
    expect(retried).toEqual(created);
    expect(send).toEqual({ kind: 'refused', code: 'session_not_bound' });
    const inbox = await call(report.origin, { path: '/api/human/channel-requests', headers: owner });
    expect(inbox.json.requests).toMatchObject([{ operationKind: 'create', outcome: 'pending_owner', requester: { harness: 'claude' } }]);
  });

  it('binds only the requesting session: request, owner approval, grant and activation', async () => {
    const { report, owner, channelUrl, parent } = await launched();
    const root = path.join(parent, 'internal');
    const granted = 'session-granted';
    const bystander = 'session-bystander';

    const [requested] = await serve(report.descriptorPath, granted, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(requested).toMatchObject({ ok: true, outcome: 'pending_owner' });
    const operationId = requested!.operationId as string;
    // The plugin's hooks stay inert for a session that has only asked.
    await expect(sessionGranted(root, granted)).resolves.toBe(false);

    // The owner decides in their own UI; nothing waited meanwhile.
    await approvePending(report.origin, owner);

    // A second session in the same working directory asks for the same channel after the approval.
    const [asked] = await serve(report.descriptorPath, bystander, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(asked).toMatchObject({ ok: true, outcome: 'pending_owner' });
    expect(asked!.operationId).not.toBe(operationId);

    // The granted session's status resumes the approved request into a live binding.
    const [status, send, who] = await serve(report.descriptorPath, granted, [
      ['khala_channel_access_status', { operationId }],
      ['khala_send', { message: 'hello from Claude' }],
      ['khala_list_agents'],
    ]);
    expect(status).toMatchObject({ ok: true, operationId, outcome: 'connected' });
    expect(send).toMatchObject({ kind: 'accepted' });
    expect(who).toMatchObject({ ok: true, v: 1 });
    const agents = (who as { agents: Array<{ participantId: string; ownerDisplayName: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.ownerDisplayName).toBe('Owner');
    // The hooks' local check finds the grant this route wrote, and only for that session.
    await expect(sessionGranted(root, granted)).resolves.toBe(true);
    await expect(sessionGranted(root, bystander)).resolves.toBe(false);

    // The bystander holds no binding: the grant bound the requesting session only.
    const [otherSend, otherWho, otherStatus] = await serve(report.descriptorPath, bystander, [
      ['khala_send', { message: 'not mine' }],
      ['khala_list_agents'],
      ['khala_channel_access_status', { operationId }],
    ]);
    expect(otherSend).toEqual({ kind: 'refused', code: 'session_not_bound' });
    expect(otherWho).toEqual({ ok: false, error: 'not_joined' });
    // Another session's operation is not its own: it learns nothing of the grant.
    expect(otherStatus).toMatchObject({ ok: true, operationId, outcome: 'unavailable' });

    // The message reached the channel, authored by the granted session's agent.
    const timeline = await call(report.origin, { path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/timeline`, headers: owner });
    expect(timeline.status).toBe(200);
    const bodies = JSON.stringify(timeline.json);
    expect(bodies).toContain('hello from Claude');
    expect(bodies).not.toContain('not mine');
    expect(bodies).toContain(agents[0]!.participantId);
  });

  // Wrong-implementation test (#420): a grant that activates only when the agent retries
  // `khala_channel_access_status` leaves the next hook boundary refused as unbound.
  it('wrong implementation: after approval the next hook boundary reports connected with no retry', async () => {
    let skew = 0;
    const { report, owner, channelUrl } = await launched(undefined, { clock: () => Date.now() + skew });
    const granted = 'session-hook-granted';
    const bystander = 'session-hook-bystander';
    const hooks = createClaudeSessionClient({ descriptorPath: report.descriptorPath });

    const [requested] = await serve(report.descriptorPath, granted, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(requested).toMatchObject({ ok: true, outcome: 'pending_owner' });
    await serve(report.descriptorPath, bystander, [['khala_list_channels']]);
    // Still pending: the boundary is the same unbound answer as before.
    await expect(hooks.hook(granted)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });

    // A boundary inside the settle interval does not ask the control plane again.
    await approvePending(report.origin, owner);
    await expect(hooks.hook(granted)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    skew += CLAUDE_SETTLE_INTERVAL_MS;

    // The next boundary settles the grant itself; the agent never calls the status tool again.
    await expect(hooks.hook(granted)).resolves.toEqual({ kind: 'hook', effective: null, watchSeconds: null, access: 'connected' });
    // Reported once; the session stays connected.
    await expect(hooks.hook(granted)).resolves.toEqual({ kind: 'hook', effective: null, watchSeconds: null, access: null });
    const [send, who] = await serve(report.descriptorPath, granted, [
      ['khala_send', { message: 'hello without a retry' }], ['khala_list_agents'],
    ]);
    expect(send).toMatchObject({ kind: 'accepted' });
    expect((who as { agents: unknown[] }).agents).toHaveLength(1);
    // The grant bound the requesting session only.
    await expect(hooks.hook(bystander)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    // A later explicit status call is harmless and reads the same grant.
    const [status] = await serve(report.descriptorPath, granted, [['khala_channel_access_status', { operationId: requested!.operationId }]]);
    expect(status).toMatchObject({ ok: true, outcome: 'connected' });
  });

  // Wrong-implementation test: a `Stop` boundary held to the settle interval lets the
  // session idle unbound after the owner approved it.
  it('settles at the turn-ending Stop boundary whatever the settle interval', async () => {
    const frozen = Date.now();
    const { report, owner, channelUrl } = await launched(undefined, { clock: () => frozen });
    const session = 'session-hook-stop';
    const hooks = createClaudeSessionClient({ descriptorPath: report.descriptorPath });
    const [requested] = await serve(report.descriptorPath, session, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(requested).toMatchObject({ outcome: 'pending_owner' });
    await expect(hooks.hook(session)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });

    // The clock never moves: every other boundary stays inside the interval.
    await approvePending(report.origin, owner);
    await expect(hooks.hook(session)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    await expect(hooks.hook(session, { stop: true })).resolves.toEqual({ kind: 'hook', effective: null, watchSeconds: null, access: 'connected' });
    await expect(hooks.hook(session)).resolves.toEqual({ kind: 'hook', effective: null, watchSeconds: null, access: null });
  });

  it('reports a denial at the next hook boundary, and the session stays unbound', async () => {
    const { report, owner, channelUrl } = await launched();
    const session = 'session-hook-denied';
    const [requested] = await serve(report.descriptorPath, session, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(requested).toMatchObject({ outcome: 'pending_owner' });
    const inbox = await call(report.origin, { path: '/api/human/channel-requests', headers: owner });
    const { requestHandle, revision } = inbox.json.requests[0] as { requestHandle: string; revision: string };
    const decided = await call(report.origin, {
      method: 'POST', path: `/api/human/channel-access-requests/${requestHandle}/decision`, headers: owner,
      body: { v: 1, requestHandle, expectedRevision: revision, decision: 'deny', operationId: 'deny-hook-1' },
    });
    expect(decided.status).toBe(200);

    const hooks = createClaudeSessionClient({ descriptorPath: report.descriptorPath });
    await expect(hooks.hook(session)).resolves.toEqual({ kind: 'hook', effective: null, watchSeconds: null, access: 'denied' });
    await expect(hooks.hook(session)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
  });

  it('Stop cancels an approval the session has not activated yet: its next status reports it revoked', async () => {
    const { report, owner, channelUrl, parent } = await launched();
    const sessionId = 'session-stopped';
    const [requested] = await serve(report.descriptorPath, sessionId, [['khala_request_channel_access', { target: channelUrl }]]);
    const operationId = requested!.operationId as string;
    await approvePending(report.origin, owner);

    // No binding exists yet, so Stop has none to name; it still closes the approval.
    const stopped = await call(report.origin, {
      method: 'POST', path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/stop`, headers: owner,
      body: { v: 1, targets: null },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.json).toEqual({ v: 1, outcome: 'stopped', stopped: [], remaining: [] });

    // The session's next status is where it would have bound: it binds nothing.
    const [status, send, who] = await serve(report.descriptorPath, sessionId, [
      ['khala_channel_access_status', { operationId }],
      ['khala_send', { message: 'after Stop' }],
      ['khala_list_agents'],
    ]);
    expect(status).toMatchObject({ ok: true, operationId, outcome: 'revoked' });
    expect(send).toEqual({ kind: 'refused', code: 'session_not_bound' });
    expect(who).toEqual({ ok: false, error: 'not_joined' });
    await expect(sessionGranted(path.join(parent, 'internal'), sessionId)).resolves.toBe(false);
    const timeline = await call(report.origin, { path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/timeline`, headers: owner });
    expect(JSON.stringify(timeline.json)).not.toContain('after Stop');
  });

  // Wrong-implementation test (#431): without the cancellation, the boundary after Stop
  // settles the approval and reports the session connected.
  it('Stop before the next hook boundary leaves the approved session unbound', async () => {
    const { report, owner, channelUrl, parent } = await launched();
    const sessionId = 'session-hook-stopped';
    const hooks = createClaudeSessionClient({ descriptorPath: report.descriptorPath });
    const [requested] = await serve(report.descriptorPath, sessionId, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(requested).toMatchObject({ outcome: 'pending_owner' });
    await approvePending(report.origin, owner);
    const stopped = await call(report.origin, {
      method: 'POST', path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/stop`, headers: owner,
      body: { v: 1, targets: null },
    });
    expect(stopped.status).toBe(200);

    await expect(hooks.hook(sessionId, { stop: true })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    await expect(hooks.hook(sessionId)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
    const [send, status] = await serve(report.descriptorPath, sessionId, [
      ['khala_send', { message: 'after Stop' }],
      ['khala_channel_access_status', { operationId: requested!.operationId }],
    ]);
    expect(send).toEqual({ kind: 'refused', code: 'session_not_bound' });
    expect(status).toMatchObject({ ok: true, outcome: 'revoked' });
    await expect(sessionGranted(path.join(parent, 'internal'), sessionId)).resolves.toBe(false);
  });

  // Wrong-implementation test (#437): answering the repeat request with the revoked
  // operation leaves the owner nothing to approve and the session unbound.
  it('after Stop, the same session asks again as a new request the owner approves', async () => {
    const { report, owner, channelUrl } = await launched();
    const sessionId = 'session-asks-again';
    const hooks = createClaudeSessionClient({ descriptorPath: report.descriptorPath });
    const [requested] = await serve(report.descriptorPath, sessionId, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(requested).toMatchObject({ outcome: 'pending_owner' });
    await approvePending(report.origin, owner);
    await expect(hooks.hook(sessionId, { stop: true })).resolves.toMatchObject({ kind: 'hook', access: 'connected' });
    const stopped = await call(report.origin, {
      method: 'POST', path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/stop`, headers: owner,
      body: { v: 1, targets: null },
    });
    expect(stopped.status).toBe(200);
    await expect(hooks.hook(sessionId)).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });

    // Asking again is a new operation awaiting the owner; it admits nothing by itself.
    const [again, repeated] = await serve(report.descriptorPath, sessionId, [
      ['khala_request_channel_access', { target: channelUrl }],
      ['khala_request_channel_access', { target: channelUrl }],
    ]);
    expect(again).toMatchObject({ ok: true, outcome: 'pending_owner' });
    expect(again!.operationId).not.toBe(requested!.operationId);
    // Repeating a live request stays idempotent.
    expect(repeated).toMatchObject({ ok: true, operationId: again!.operationId, outcome: 'pending_owner' });
    await expect(hooks.hook(sessionId, { stop: true })).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });

    await approvePending(report.origin, owner);
    await expect(hooks.hook(sessionId, { stop: true })).resolves.toMatchObject({ kind: 'hook', access: 'connected' });
    const [send, status] = await serve(report.descriptorPath, sessionId, [
      ['khala_send', { message: 'back after Stop' }],
      ['khala_channel_access_status', { operationId: requested!.operationId }],
    ]);
    expect(send).toMatchObject({ kind: 'accepted' });
    // The Stopped operation itself never reads as connected again.
    expect(status).toMatchObject({ operationId: requested!.operationId });
    expect(status!.outcome).not.toBe('connected');
  });

  it('after Stop cancels an unactivated approval, the same session asks again as a new request', async () => {
    const { report, owner, channelUrl } = await launched();
    const sessionId = 'session-asks-again-approved';
    const hooks = createClaudeSessionClient({ descriptorPath: report.descriptorPath });
    const [requested] = await serve(report.descriptorPath, sessionId, [['khala_request_channel_access', { target: channelUrl }]]);
    await approvePending(report.origin, owner);
    const stopped = await call(report.origin, {
      method: 'POST', path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/stop`, headers: owner,
      body: { v: 1, targets: null },
    });
    expect(stopped.status).toBe(200);

    const [again] = await serve(report.descriptorPath, sessionId, [['khala_request_channel_access', { target: channelUrl }]]);
    expect(again).toMatchObject({ ok: true, outcome: 'pending_owner' });
    expect(again!.operationId).not.toBe(requested!.operationId);
    await approvePending(report.origin, owner);
    await expect(hooks.hook(sessionId, { stop: true })).resolves.toMatchObject({ kind: 'hook', access: 'connected' });
  });

  it('re-activates a granted session after the launcher resumes, with the same binding', async () => {
    const first = await launched();
    const sessionId = 'session-restart';
    const [requested] = await serve(first.report.descriptorPath, sessionId, [['khala_request_channel_access', { target: first.channelUrl }]]);
    const operationId = requested!.operationId as string;
    await approvePending(first.report.origin, first.owner);
    const [connected, sent] = await serve(first.report.descriptorPath, sessionId, [
      ['khala_channel_access_status', { operationId }],
      ['khala_send', { message: 'before the restart' }],
    ]);
    expect(connected).toMatchObject({ outcome: 'connected' });
    expect(sent).toMatchObject({ kind: 'accepted' });
    const [roster] = await serve(first.report.descriptorPath, sessionId, [['khala_list_agents']]);
    await first.shutdown();

    const second = await launched({ parent: first.parent, channelId: first.report.channelId, port: first.report.port });
    expect(second.report.origin).toBe(first.report.origin);
    // The grant from the previous launch ended with it: the session is unbound until it resumes.
    const [unbound] = await serve(second.report.descriptorPath, sessionId, [['khala_send', { message: 'stale grant' }]]);
    expect(unbound).toEqual({ kind: 'refused', code: 'session_not_bound' });
    // So are the plugin's hooks: the stale grant does not match the new launch.
    const root = path.join(first.parent, 'internal');
    await expect(sessionGranted(root, sessionId)).resolves.toBe(false);

    // Its status resumes the connected operation into a fresh capability for the same binding.
    const [resumed, again, who] = await serve(second.report.descriptorPath, sessionId, [
      ['khala_channel_access_status', { operationId }],
      ['khala_send', { message: 'after the restart' }],
      ['khala_list_agents'],
    ]);
    expect(resumed).toMatchObject({ ok: true, operationId, outcome: 'connected' });
    expect(again).toMatchObject({ kind: 'accepted' });
    expect(who).toEqual(roster);
    await expect(sessionGranted(root, sessionId)).resolves.toBe(true);
    const inbox = await call(second.report.origin, { path: '/api/human/channel-requests', headers: second.owner });
    expect((inbox.json.requests as Array<{ outcome: string }>).filter(entry => entry.outcome === 'pending_owner')).toEqual([]);
    const timeline = await call(second.report.origin, {
      path: `/api/v1/channels/${encodeURIComponent(second.report.channelId)}/timeline`, headers: second.owner,
    });
    const bodies = JSON.stringify(timeline.json);
    expect(bodies).toContain('after the restart');
    expect(bodies).not.toContain('stale grant');
  });
});

describe('Claude delivery through the internal launcher', () => {
  /** Binds `sessionId` to the launch channel through request, owner approval and activation. */
  async function bound(sessionId: string, claudeVersion?: () => Promise<string | null>) {
    const launch = await launched(undefined, claudeVersion === undefined ? {} : { claudeVersion });
    const [requested] = await serve(launch.report.descriptorPath, sessionId, [['khala_request_channel_access', { target: launch.channelUrl }]]);
    await approvePending(launch.report.origin, launch.owner);
    const [status] = await serve(launch.report.descriptorPath, sessionId, [
      ['khala_channel_access_status', { operationId: requested!.operationId }],
    ]);
    expect(status).toMatchObject({ outcome: 'connected' });
    let posted = 0;
    const post = async (body: string) => {
      posted += 1;
      const sent = await call(launch.report.origin, {
        method: 'POST', path: `/api/v1/channels/${encodeURIComponent(launch.report.channelId)}/messages`, headers: launch.owner,
        body: { clientTxnId: `txn-${posted}`, content: { v: 1, kind: 'text', body } },
      });
      expect(sent.status).toBe(201);
      return sent.json.event.eventId as string;
    };
    const root = path.join(launch.parent, 'internal');
    return {
      ...launch, post, run: (op: string) => claude(launch.report.descriptorPath, op, sessionId),
      /** The session's own granted descriptor, which a descriptor client presents as that binding. */
      grantPath: path.join(root, INTERNAL_DISCOVERY_DIRECTORY, discoveryPrincipal('claude', sessionId), CLAUDE_GRANT_FILE),
      receiptLog: path.join(channelDirectory(root, launch.report.channelId)!, RECEIPT_LOG_FILE),
      /** The owner's receipt evidence for the launch channel. */
      async facts() {
        const read = await call(launch.report.origin, {
          path: `/api/v1/channels/${encodeURIComponent(launch.report.channelId)}/receipts`, headers: launch.owner,
        });
        expect(read.status).toBe(200);
        return read.json.facts as Array<{
          receipt: { kind: string; source: string; releaseId: string; bindingId: string; generation: number; receiptId: string };
          evidenceRef: string; events: Array<{ eventId: string; sequence: number | null }>;
        }>;
      },
    };
  }

  // Wrong-implementation test (#443): a feed that starts at sequence 0 hands the rejoined
  // binding every earlier message, including the one sent while no agent was bound.
  it('delivers a session that rejoins after Stop only what was said after it rejoined, under history: none', async () => {
    const { report, owner, channelUrl } = await launched();
    const sessionId = 'session-rejoins';
    const hooks = createClaudeSessionClient({ descriptorPath: report.descriptorPath });
    const run = (op: string) => claude(report.descriptorPath, op, sessionId);
    let posted = 0;
    const post = async (body: string) => {
      posted += 1;
      const sent = await call(report.origin, {
        method: 'POST', path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/messages`, headers: owner,
        body: { clientTxnId: `txn-rejoin-${posted}`, content: { v: 1, kind: 'text', body } },
      });
      expect(sent.status).toBe(201);
    };
    const join = async () => {
      const [requested] = await serve(report.descriptorPath, sessionId, [['khala_request_channel_access', { target: channelUrl }]]);
      expect(requested).toMatchObject({ ok: true, outcome: 'pending_owner' });
      await approvePending(report.origin, owner);
      await expect(hooks.hook(sessionId, { stop: true })).resolves.toMatchObject({ kind: 'hook', access: 'connected' });
    };

    await post('said before any admission');
    await join();
    await post('said to the first binding');
    const first = await run('read');
    expect(first).toContain('said to the first binding');
    expect(first).not.toContain('said before any admission');

    const stopped = await call(report.origin, {
      method: 'POST', path: `/api/v1/channels/${encodeURIComponent(report.channelId)}/stop`, headers: owner,
      body: { v: 1, targets: null },
    });
    expect(stopped.status).toBe(200);
    await post('said while no agent was bound');

    await join();
    await post('said after the rejoin');
    const rejoined = await run('read');
    expect(rejoined).toContain('said after the rejoin');
    for (const earlier of ['said before any admission', 'said to the first binding', 'said while no agent was bound']) {
      expect(rejoined).not.toContain(earlier);
    }
  });

  /**
   * `khala read --internal-descriptor <grant>` in its own inbox state, as `main.ts` composes it.
   * `dropRecorder` opens the inbox the way internal mode did before receipts were wired.
   */
  async function descriptorRead(grantPath: string, stateDirectory: string, args: readonly string[] = [], dropRecorder = false) {
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', chunk => { out += chunk; });
    const stderr = new PassThrough();
    let err = '';
    stderr.on('data', chunk => { err += chunk; });
    const code = await runCli(['--internal-descriptor', grantPath, 'read', ...args], {
      client: createUnavailableClient(),
      inbox: (bindingId, generation, inboxOptions) => openInbox({
        stateDirectory, bindingId, generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
        ...(dropRecorder ? {} : inboxOptions),
      }),
      stdin: Readable.from([]), stdout, stderr,
      internalClient: async descriptorPath => createInternalClient({ descriptorPath }),
      internalDelivery: async descriptorPath => createInternalDelivery({ descriptorPath, stateDirectory }),
    });
    expect({ code, err }).toEqual({ code: 0, err: '' });
    return out;
  }

  const tokenOf = (framed: string): string | null => /^batchToken: (\S+)$/m.exec(framed)?.[1] ?? null;

  function scratchState(): string {
    const directory = fs.mkdtempSync('/tmp/khala-cli-state-');
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
  }

  it('records the owner an agent_acknowledged receipt at the Claude session\'s next Khala call, never at the read', async () => {
    const session = await bound('session-receipts');
    const eventId = await session.post('owner asks');

    expect(await session.run('read')).toContain('owner asks');
    // Delivery and the read itself acknowledge nothing.
    expect(await session.facts()).toEqual([]);

    expect(JSON.parse(await session.run('status'))).toEqual({ ok: true, kind: 'status', acknowledged: 1 });
    const facts = await session.facts();
    expect(facts).toHaveLength(1);
    const { receipt } = facts[0]!;
    expect(receipt).toMatchObject({ kind: 'agent_acknowledged', source: 'agent' });
    // Exactly the release the server made for this binding generation and event.
    expect(receipt.releaseId).toBe(internalReleaseId(receipt, eventId));
    expect(facts[0]!.events).toEqual([{ eventId, sequence: expect.any(Number) }]);
    // The owner's structured log carries the same content-free observation.
    const logged = fs.readFileSync(session.receiptLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(logged).toMatchObject([{ event: 'khala.receipt.observed', receiptId: receipt.receiptId, kind: 'agent_acknowledged' }]);
    expect(fs.readFileSync(session.receiptLog, 'utf8')).not.toContain('owner asks');

    // A repeated call has nothing left to acknowledge and records nothing more.
    expect(JSON.parse(await session.run('status'))).toEqual({ ok: true, kind: 'status', acknowledged: 0 });
    expect(await session.facts()).toHaveLength(1);
  });

  it('records a descriptor read\'s acknowledgement only for the exact outstanding token', async () => {
    const session = await bound('session-cli-receipts');
    const state = scratchState();
    const first = await session.post('first for the cli');

    const framed = await descriptorRead(session.grantPath, state);
    expect(framed).toContain('first for the cli');
    const token = tokenOf(framed)!;
    expect(token).not.toBeNull();

    // A wrong token returns the same batch under the same token and records nothing.
    const wrong = await descriptorRead(session.grantPath, state, ['--ack', 'not-the-batch-token']);
    expect(tokenOf(wrong)).toBe(token);
    expect(await session.facts()).toEqual([]);

    // The exact token acknowledges the batch: one receipt for that release.
    expect(JSON.parse(await descriptorRead(session.grantPath, state, ['--ack', token]))).toEqual({ ok: true, kind: 'empty' });
    const facts = await session.facts();
    expect(facts.map(fact => fact.events.map(event => event.eventId))).toEqual([[first]]);
    expect(facts[0]!.receipt.releaseId).toBe(internalReleaseId(facts[0]!.receipt, first));

    // A stale token never acknowledges a later batch.
    await session.post('second for the cli');
    const later = await descriptorRead(session.grantPath, state, ['--ack', token]);
    expect(later).toContain('second for the cli');
    const laterToken = tokenOf(later)!;
    expect(laterToken).not.toBe(token);
    expect(tokenOf(await descriptorRead(session.grantPath, state, ['--ack', token]))).toBe(laterToken);
    expect(await session.facts()).toHaveLength(1);

    // Replaying the acknowledged token again records no second receipt either.
    expect(JSON.parse(await descriptorRead(session.grantPath, state, ['--ack', laterToken]))).toEqual({ ok: true, kind: 'empty' });
    expect(await session.facts()).toHaveLength(2);
    expect(JSON.parse(await descriptorRead(session.grantPath, state, ['--ack', laterToken]))).toEqual({ ok: true, kind: 'empty' });
    expect(await session.facts()).toHaveLength(2);
  });

  it('wrong implementation: an internal inbox opened without its recorder acknowledges into nothing', async () => {
    const session = await bound('session-no-recorder');
    const state = scratchState();
    await session.post('never receipted');
    const token = tokenOf(await descriptorRead(session.grantPath, state, [], true))!;
    // The cursor moves as if acknowledged, yet the owner has no evidence: the check above catches it.
    expect(JSON.parse(await descriptorRead(session.grantPath, state, ['--ack', token], true))).toEqual({ ok: true, kind: 'empty' });
    expect(await session.facts()).toEqual([]);
  });

  it('delivers to a bound session on an experimental route: hook pull, then read, then next-call acknowledgement', async () => {
    const session = await bound('session-delivered');

    // The route is labelled experimental for the inspected version, never proven.
    const mode = JSON.parse(await session.run('mode'));
    expect(mode).toMatchObject({
      ok: true, acknowledgement: 'batch_token_next_call',
      support: { steer: 'experimental', sync: 'experimental', async: 'experimental' },
    });
    // The owner's view projects the binding through the same inspected claim.
    const listed = await call(session.report.origin, {
      path: `/api/v1/channels/${encodeURIComponent(session.report.channelId)}/bindings`, headers: session.owner,
    });
    expect(listed.status).toBe(200);
    expect(listed.json.bindings).toMatchObject([{
      harnessVersion: INSTALLED_CLAUDE, view: { support: { sync: { status: 'experimental', testedVersion: INSTALLED_CLAUDE } } },
    }]);

    await session.post('first from the owner');
    // A hook pull delivers the batch but never acknowledges it: a second pull replays it.
    const pulled = await session.run('pull');
    expect(pulled).toContain('first from the owner');
    expect(await session.run('pull')).toBe(pulled);

    // The agent's own read acknowledges the pulled batch and delivers what arrived since.
    await session.post('second from the owner');
    const read = await session.run('read');
    expect(read).toContain('second from the owner');
    expect(read).not.toContain('first from the owner');

    // The next Khala call acknowledges the read's batch; nothing is left to pull.
    expect(JSON.parse(await session.run('status'))).toEqual({ ok: true, kind: 'status', acknowledged: 1 });
    expect(JSON.parse(await session.run('pull'))).toEqual({ ok: true, kind: 'empty' });

    // A reply acknowledges too: a pulled batch is not replayed after the agent sends.
    await session.post('third from the owner');
    expect(await session.run('pull')).toContain('third from the owner');
    const [sent] = await serve(session.report.descriptorPath, 'session-delivered', [['khala_send', { message: 'thanks' }]]);
    expect(sent).toMatchObject({ kind: 'accepted' });
    expect(JSON.parse(await session.run('pull'))).toEqual({ ok: true, kind: 'empty' });
  });

  it('delivers at the next PostToolUse under steer only after the owner grants the experimental route', async () => {
    const session = await bound('session-granted');
    const bindings = `/api/v1/channels/${encodeURIComponent(session.report.channelId)}/bindings`;
    const [entry] = (await call(session.report.origin, { path: bindings, headers: session.owner })).json.bindings;
    const binding = `${bindings}/${encodeURIComponent(entry.binding.bindingId)}`;
    const owner = (path: string, body: unknown) => call(session.report.origin, { method: 'POST', path: `${binding}/${path}`, headers: session.owner, body });
    // The Claude plugin's own PostToolUse hook, running `khala claude <op>` for this session.
    const postToolUse = () => runHook('post-tool-use', JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-granted', tool_name: 'Bash' }), {
      bound: sessionId => sessionGranted(path.join(session.parent, 'internal'), sessionId),
      khala: async op => ({ code: 0, stdout: await session.run(op) }),
      stateRoot: path.join(session.parent, 'claude-hooks'),
      sleep: async () => undefined,
      now: () => Date.now(),
      nonce: () => 'nonce',
      parentAlive: () => true,
    });
    const issuedAt = new Date().toISOString();
    const steer = await owner('listening-mode', {
      v: 1, commandId: 'steer-1', generation: entry.binding.generation, expectedVersion: entry.view.version, requested: 'steer', issuedAt,
    });
    expect(steer.json).toMatchObject({ outcome: 'applied', requested: 'steer', effective: null });

    // Without the grant the requested experimental mode is not in effect, so the hook pulls nothing.
    expect(JSON.parse(await session.run('hook'))).toMatchObject({ ok: true, kind: 'hook', effective: null });
    await session.post('held without a grant');
    expect(await postToolUse()).toEqual({ stdout: '', stderr: '', exitCode: 0 });

    const { steer: support } = entry.view.support;
    const pin = { mode: 'steer', route: support.route, harnessVersion: support.testedVersion, evidenceRevision: support.evidenceRevision };
    const granted = await owner('experimental-route/grant', {
      v: 1, commandId: 'grant-1', generation: entry.binding.generation, expectedVersion: steer.json.version, ...pin, issuedAt,
    });
    expect(granted.json).toMatchObject({ outcome: 'applied', view: { effective: 'steer' } });
    expect(JSON.parse(await session.run('hook'))).toMatchObject({ ok: true, kind: 'hook', effective: 'steer' });
    const delivered = await postToolUse();
    expect(delivered.stdout).toContain('held without a grant');

    // Revoking the grant stops hook delivery again.
    await session.run('status');
    const revoked = await owner('experimental-route/revoke', {
      v: 1, commandId: 'revoke-1', generation: entry.binding.generation, expectedVersion: granted.json.view.version, ...pin, issuedAt,
    });
    expect(revoked.json).toMatchObject({ outcome: 'applied', view: { effective: null } });
    await session.post('held after revoke');
    expect(await postToolUse()).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('keeps a Claude whose version cannot be inspected unproven: nothing is pulled or read', async () => {
    const session = await bound('session-uninspected', async () => null);
    expect(JSON.parse(await session.run('mode'))).toMatchObject({
      ok: true, acknowledgement: 'unknown', support: { steer: 'unproven', sync: 'unproven', async: 'unproven' },
    });
    await session.post('never delivered');
    expect(JSON.parse(await session.run('pull'))).toEqual({ ok: false, kind: 'refused', code: 'unproven' });
    expect(JSON.parse(await session.run('read'))).toEqual({ ok: false, kind: 'refused', code: 'unproven' });
  });
});
