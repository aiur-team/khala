import fs from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInternalClient } from '@aiur/khala/composition/internal';
import type { OpenCodePluginClient } from '@aiur/khala/opencode';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { webBundleManifest } from '../../launcher/bundle';
import { launchInternal } from '../../launcher/launcher';
import { issueDiscoveryDescriptor } from '../discovery-descriptor';

// The installed OpenCode plugin entry, the built `opencode.js` that `khala setup` copies
// and OpenCode loads, against the real internal launcher. It is built here by the same
// `bundleOpenCodePlugin` the package build runs, into a private directory, so the test
// never reads a stale `dist/` nor races the CLI tests that rebuild it. The session discovers, requests
// access, is approved in the owner's own UI and activates its own grant. Only OpenCode's
// in-process client is a stand-in. Nothing here stands in for the grant, the server's
// release feed or the inbox.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureBundle = path.join(here, '..', '..', 'launcher', 'fixtures', 'internal-web');
const bundleScript = path.resolve(here, '../../../../../packages/agent-cli/scripts/bundle.mjs');
const cleanups: Array<() => Promise<void> | void> = [];

type OpenCodePluginModule = typeof import('@aiur/khala/opencode');
let plugin: OpenCodePluginModule;
let built: string;
beforeAll(async () => {
  built = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'khala-opencode-plugin-'));
  const outfile = path.join(built, 'opencode.js');
  const { bundleOpenCodePlugin } = await import(/* @vite-ignore */ pathToFileURL(bundleScript).href) as
    { bundleOpenCodePlugin(options: { outfile: string }): Promise<unknown> };
  await bundleOpenCodePlugin({ outfile });
  plugin = await import(/* @vite-ignore */ pathToFileURL(outfile).href) as OpenCodePluginModule;
}, 60_000);
afterAll(() => fs.rmSync(built, { recursive: true, force: true }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
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

const SESSION = 'ses_khala_plugin_a';
const DIRECTORY = '/work/project';
const MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-5' };

/** A launcher whose state root is `$XDG_STATE_HOME/khala/internal`, where the plugin looks. */
async function launched() {
  const state = fs.mkdtempSync('/tmp/khala-opencode-');
  cleanups.push(() => fs.rmSync(state, { recursive: true, force: true }));
  vi.stubEnv('XDG_STATE_HOME', state);
  const root = path.join(state, 'khala', 'internal');
  fs.mkdirSync(path.dirname(root), { mode: 0o700 });
  const outcome = await launchInternal({
    root, assets: webBundleManifest(fixtureBundle), request: { kind: 'create' }, startPort: 0,
  });
  if (outcome.kind !== 'running') throw new Error(`launch failed: ${outcome.code}`);
  cleanups.push(() => outcome.shutdown());
  const { report } = outcome;
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
  let sent = 0;
  return {
    root,
    report,
    owner,
    channelUrl: `${report.origin}/channels/${report.channelId}`,
    async say(body: string): Promise<string> {
      const reply = await call(report.origin, {
        method: 'POST', path: `/api/v1/channels/${report.channelId}/messages`, headers: owner,
        body: { clientTxnId: `txn-opencode-${String(++sent).padStart(4, '0')}`, content: { v: 1, kind: 'text', body } },
      });
      expect(reply.status).toBe(201);
      return reply.json.event.eventId as string;
    },
  };
}

type World = Awaited<ReturnType<typeof launched>>;

/** `khala internal discovery` and `join` for one OpenCode session, then the owner's approval. */
async function bind(w: World, sessionId: string): Promise<void> {
  const issued = await issueDiscoveryDescriptor({
    root: w.root,
    command: { kind: 'discovery', harness: 'opencode', sessionId, displayLabel: null, workspaceLabel: null },
  });
  if (issued.kind !== 'issued') throw new Error(`discovery failed: ${issued.code}`);
  const agent = createInternalClient({ descriptorPath: issued.descriptorPath });
  expect(await agent.requestAccess!(w.channelUrl)).toEqual({ kind: 'status', outcome: 'pending_owner' });
  const inbox = await call(w.report.origin, { path: '/api/human/channel-requests', headers: w.owner });
  const pending = (inbox.json.requests as Array<{ requestHandle: string; revision: string; outcome: string; requester: { harness: string } }>)
    .filter(entry => entry.outcome === 'pending_owner');
  expect(pending).toHaveLength(1);
  expect(pending[0]!.requester.harness).toBe('opencode');
  const { requestHandle, revision } = pending[0]!;
  const decided = await call(w.report.origin, {
    method: 'POST', path: `/api/human/channel-access-requests/${requestHandle}/decision`, headers: w.owner,
    body: { v: 1, requestHandle, expectedRevision: revision, decision: 'approve', operationId: `decide-${requestHandle.slice(-8)}` },
  });
  expect(decided.status).toBe(200);
  expect(await agent.requestAccess!(w.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });
}

/** OpenCode's in-process client for one idle TUI session: status, history and `promptAsync`. */
function openCode() {
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const messages = [{ info: { id: 'msg_user_1', sessionID: SESSION, role: 'user', model: MODEL }, parts: [{ type: 'text', text: 'hi' }] }];
  const client: OpenCodePluginClient = {
    session: {
      status: async () => ({ data: {} }),
      get: async () => ({ data: { id: SESSION } }),
      messages: async () => ({ data: messages }),
      promptAsync: async options => {
        prompts.push({ sessionID: options.path.id, text: options.body.parts[0].text });
        return { data: undefined };
      },
    },
  };
  return { client, prompts };
}

/** Runs the plugin as OpenCode at `version` would, with OpenCode's own executable path. */
async function loadPlugin(client: OpenCodePluginClient, version: string) {
  const execPath = process.execPath;
  process.execPath = `/home/person/.opencode/versions/opencode/${version}/opencode`;
  try {
    const hooks = await plugin.default.server({ client, directory: DIRECTORY });
    cleanups.push(() => hooks.dispose());
    return hooks;
  } finally {
    process.execPath = execPath;
  }
}

async function eventually<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function batchOf(result: string) {
  const [head, envelope] = result.split('\n\n');
  expect(JSON.parse(head!)).toEqual({ kind: 'batch' });
  const parsed = plugin.parseOpenCodeEnvelope(envelope!);
  expect(parsed).not.toBeNull();
  return { ...parsed!, text: envelope! };
}

/** The owner's `/bindings` row for the one bound session. */
async function ownerBinding(w: World) {
  const bindings = await call(w.report.origin, { path: `/api/v1/channels/${w.report.channelId}/bindings`, headers: w.owner });
  expect(bindings.status).toBe(200);
  return bindings.json.bindings[0] as {
    binding: { bindingId: string; generation: number; agentParticipantId: string }; idleDelivery: string;
  };
}

async function ownerView(w: World) {
  const { bindingId } = (await ownerBinding(w)).binding;
  const mode = await call(w.report.origin, {
    path: `/api/v1/channels/${w.report.channelId}/bindings/${bindingId}/listening-mode`, headers: w.owner,
  });
  expect(mode.status).toBe(200);
  return mode.json.view as { effective: string | null; support: Record<string, { status: string }> };
}

describe('the installed OpenCode plugin against the internal launcher', () => {
  it('delivers to the idle bound session, reads with khala_read and acknowledges on the next Khala call', async () => {
    const w = await launched();
    await bind(w, SESSION);
    const { client, prompts } = openCode();
    const hooks = await loadPlugin(client, '1.17.10');
    // The `join` the agent ran in its bash tool is the first hook the plugin sees.
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: SESSION });

    // Proven for the exact tested version, as the owner sees it once the plugin reported.
    const view = await eventually(() => ownerView(w), current => current.support.sync?.status === 'proven');
    expect(view.support).toMatchObject({ steer: { status: 'proven' }, sync: { status: 'proven' }, async: { status: 'proven' } });
    expect(view.effective).toBe('sync');
    expect((await ownerBinding(w)).idleDelivery).toBe('proven');

    // `sync` at rest: the pulled release reaches the idle session through one `promptAsync`.
    await w.say('meet at the north door');
    await eventually(() => prompts.length, count => count > 0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionID).toBe(SESSION);
    const delivered = plugin.parseOpenCodeEnvelope(prompts[0]!.text)!;
    expect(prompts[0]!.text).toContain('meet at the north door');

    // `khala_read` returns the same outstanding batch until the agent's next Khala call acknowledges it.
    const read = batchOf(await hooks.tool.khala_read.execute({}, { sessionID: SESSION }));
    expect(read.token).toBe(delivered.token);
    expect(read.releaseIds).toEqual(delivered.releaseIds);

    // A later message becomes the next batch only after the acknowledgement.
    await w.say('bring the map');
    const acknowledged = await eventually(
      () => hooks.tool.khala_read.execute({ ackBatchToken: read.token }, { sessionID: SESSION }),
      result => result.includes('bring the map'),
    );
    const next = batchOf(acknowledged);
    expect(next.token).not.toBe(read.token);
    expect(next.text).not.toContain('meet at the north door');

    // `khala_send` is the next Khala call that acknowledges this one; nothing follows it.
    const sent = await hooks.tool.khala_send.execute({ message: 'on my way', ackBatchToken: next.token }, { sessionID: SESSION });
    expect(JSON.parse(sent)).toMatchObject({ kind: 'accepted' });
    expect(JSON.parse(await hooks.tool.khala_read.execute({}, { sessionID: SESSION }))).toEqual({ kind: 'empty' });
  });

  it('keeps an untested OpenCode version experimental: nothing automatic, khala_read still delivers', async () => {
    const w = await launched();
    await bind(w, SESSION);
    const { client, prompts } = openCode();
    const hooks = await loadPlugin(client, '1.18.2');
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: SESSION });

    const view = await eventually(() => ownerView(w), current => current.support.sync?.status === 'experimental');
    expect(view.support).toMatchObject({
      steer: { status: 'experimental' }, sync: { status: 'experimental' }, async: { status: 'experimental' },
    });
    expect(view.effective).toBeNull();
    // The plugin never prompts an idle session at this version, so the owner sees the next-turn notice.
    expect((await ownerBinding(w)).idleDelivery).toBe('unproven');

    await w.say('meet at the north door');
    const read = batchOf(await eventually(
      () => hooks.tool.khala_read.execute({}, { sessionID: SESSION }),
      result => result.includes('meet at the north door'),
    ));
    expect(prompts).toEqual([]);
    expect(JSON.parse(await hooks.tool.khala_read.execute({ ackBatchToken: read.token }, { sessionID: SESSION })))
      .toEqual({ kind: 'empty' });
  });

  it('ends delivery when the owner stops the binding', async () => {
    const w = await launched();
    await bind(w, SESSION);
    const { client, prompts } = openCode();
    const hooks = await loadPlugin(client, '1.17.10');
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: SESSION });
    await eventually(() => ownerView(w), current => current.support.sync?.status === 'proven');

    const stopped = await call(w.report.origin, {
      method: 'POST', path: `/api/v1/channels/${w.report.channelId}/stop`, headers: w.owner, body: { v: 1, targets: null },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.json).toMatchObject({ outcome: 'stopped', remaining: [] });

    // A message after Stop is never prompted, and neither tool reaches the channel.
    await w.say('meet at the north door');
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: SESSION });
    const notConnected = JSON.stringify({ kind: 'refused', code: 'not_connected' });
    expect(await eventually(() => hooks.tool.khala_read.execute({}, { sessionID: SESSION }), result => result === notConnected))
      .toBe(notConnected);
    expect(await hooks.tool.khala_send.execute({ message: 'on my way' }, { sessionID: SESSION })).toBe(notConnected);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(prompts).toEqual([]);
  });

  it('serves only the session that holds the grant', async () => {
    const w = await launched();
    await bind(w, SESSION);
    const { client } = openCode();
    const hooks = await loadPlugin(client, '1.17.10');
    const other = 'ses_khala_plugin_unbound';
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: other });
    expect(await hooks.tool.khala_read.execute({}, { sessionID: other })).toBe(JSON.stringify({ kind: 'refused', code: 'not_connected' }));
    expect(JSON.parse(await hooks.tool.khala_read.execute({}, { sessionID: SESSION }))).toEqual({ kind: 'empty' });
    // The bound session stays served after another session's call.
    expect(await hooks.tool.khala_read.execute({}, { sessionID: other }))
      .toBe(JSON.stringify({ kind: 'refused', code: 'binding_not_held' }));
  });
});
