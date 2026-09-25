import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { INTERNAL_ACTIVE_DESCRIPTOR_FILE, parseInternalDescriptor } from '@khala/contracts/internal/descriptor';
import { LAUNCH_RECORD_FILE } from '../descriptor/write';
import { channelDirectory } from '../lifecycle/paths';
import { createChannelStore } from '../store/channel-store';
import { openChannelStore } from '../store/open';
import { webBundleManifest } from './bundle';
import { type LaunchOutcome, type LauncherOptions, type RunningLaunch, HANDOFF_DIRECTORY, launchInternal } from './launcher';
import { acquireRootLease } from './lock';

const fixtureBundle = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'internal-web');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function makeRoot(): string {
  const base = fs.mkdtempSync(path.join('/tmp', 'khala-launcher-'));
  fs.chmodSync(base, 0o700);
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  return path.join(base, 'internal');
}

async function launch(root: string, overrides: Partial<LauncherOptions> = {}): Promise<LaunchOutcome> {
  const outcome = await launchInternal({
    root, request: { kind: 'create' }, assets: webBundleManifest(fixtureBundle), startPort: 0, ...overrides,
  });
  if (outcome.kind === 'running') cleanups.push(() => outcome.shutdown());
  return outcome;
}

async function running(root: string, overrides: Partial<LauncherOptions> = {}): Promise<RunningLaunch> {
  const outcome = await launch(root, overrides);
  if (outcome.kind !== 'running') throw new Error(`launch failed: ${outcome.code}`);
  return outcome;
}

type Reply = Readonly<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>;

function call(origin: string, input: Readonly<{ method?: string; path: string; headers?: Record<string, string>; body?: unknown }>): Promise<Reply> {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const request = httpRequest({
      host: '127.0.0.1', port: Number(port), method: input.method ?? 'GET', path: input.path,
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
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.end(body);
  });
}

/** Exchanges the printed URL's fragment exactly as the bootstrap script does. */
async function humanSession(url: string): Promise<Record<string, string>> {
  const parsed = new URL(url);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const reply = await call(parsed.origin, {
    method: 'POST', path: '/__khala/session', headers: { origin: parsed.origin },
    body: { credential: fragment.get('credential'), channelId: fragment.get('channel') },
  });
  expect(reply.status).toBe(200);
  const cookie = String((reply.headers['set-cookie'] as string[])[0]).split(';')[0]!;
  return { cookie, 'x-khala-request-secret': JSON.parse(reply.text).requestSecret, origin: parsed.origin };
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe('internal launcher', () => {
  it('creates one human-only channel, serves it, and publishes strict private descriptors', async () => {
    const root = makeRoot();
    const launched = await running(root);
    const { report } = launched;

    expect(report.channelId).toMatch(/^ch_[A-Za-z0-9_-]{22}$/);
    expect(report.resumeCommand).toBe(`khala internal --resume ${report.channelId}`);
    expect(report.descriptorPath).toBe(path.join(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE));
    expect(report.origin).toBe(`http://127.0.0.1:${report.port}`);
    expect(report.url).toMatch(new RegExp(`^${report.origin}/__khala/bootstrap#credential=[A-Za-z0-9_-]{43}&channel=${report.channelId}$`));
    expect(report.browser).toEqual({ opened: false });

    expect(mode(root)).toBe(0o700);
    const active = parseInternalDescriptor(fs.readFileSync(report.descriptorPath, 'utf8'));
    expect(active.ok && active.value).toEqual({
      v: 1, channelId: report.channelId, origin: report.origin, transportCapability: expect.any(String),
    });
    expect(mode(report.descriptorPath)).toBe(0o600);
    const channelDir = channelDirectory(root, report.channelId)!;
    const launchFile = path.join(channelDir, LAUNCH_RECORD_FILE);
    expect(mode(launchFile)).toBe(0o600);
    const record = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
    expect(record).toEqual({
      v: 1, channelId: report.channelId, origin: report.origin,
      bootstrapCredential: new URLSearchParams(new URL(report.url).hash.slice(1)).get('credential'), expiresAt: expect.any(Number),
    });
    // Transport discovery and the human bootstrap never share a secret.
    expect(record.bootstrapCredential).not.toBe(active.ok && active.value.transportCapability);
    expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);

    const session = await humanSession(report.url);
    const channel = await call(report.origin, { path: `/api/v1/channels/${report.channelId}`, headers: session });
    expect(channel.status).toBe(200);
    expect(JSON.parse(channel.text)).toMatchObject({
      channel: { channelId: report.channelId, membership: 'joined' },
      participants: [{ kind: 'human', displayName: 'Owner' }],
    });
    const page = await call(report.origin, { path: `/channels/${report.channelId}` });
    expect(page.text).toContain('fixture internal web bundle');
  });

  it('shuts down in order: discovery gone, URL unreachable, store and lease released; repeat calls are harmless', async () => {
    const root = makeRoot();
    const launched = await running(root);
    const { report } = launched;
    await Promise.all([launched.shutdown(), launched.shutdown()]);
    await launched.shutdown();

    expect(fs.existsSync(report.descriptorPath)).toBe(false);
    expect(fs.existsSync(path.join(channelDirectory(root, report.channelId)!, LAUNCH_RECORD_FILE))).toBe(false);
    await expect(call(report.origin, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const lease = acquireRootLease(root);
    expect(lease.kind).toBe('acquired');
    if (lease.kind === 'acquired') lease.lease.release();

    // The durable channel holds only the local human: no agent participant or binding exists.
    const handle = openChannelStore({ directory: channelDirectory(root, report.channelId)!, mode: 'existing' });
    try {
      const roster = createChannelStore(handle).roster(report.channelId as never);
      expect(roster.kind === 'done' && roster.participants.map(participant => participant.kind)).toEqual(['human']);
      expect(handle.read(db => db.prepare('SELECT COUNT(*) AS n FROM bindings').get())).toEqual({ n: 0 });
    } finally {
      handle.close();
    }
  });

  it('resumes the exact channel with every launch credential rotated and history preserved', async () => {
    const root = makeRoot();
    const first = await running(root);
    const session = await humanSession(first.report.url);
    const sent = await call(first.report.origin, {
      method: 'POST', path: `/api/v1/channels/${first.report.channelId}/messages`, headers: session,
      body: { clientTxnId: 'txn-1', content: { v: 1, kind: 'text', body: 'kept across resume' } },
    });
    expect(sent.status).toBe(201);
    const firstActive = fs.readFileSync(first.report.descriptorPath, 'utf8');
    await first.shutdown();

    const second = await running(root, { request: { kind: 'resume', channelId: first.report.channelId } });
    expect(second.report.channelId).toBe(first.report.channelId);
    expect(second.report.resumeCommand).toBe(first.report.resumeCommand);
    const secondActive = fs.readFileSync(second.report.descriptorPath, 'utf8');
    expect(secondActive).not.toBe(firstActive);
    const decoded = [parseInternalDescriptor(firstActive), parseInternalDescriptor(secondActive)];
    expect(decoded[0]!.ok && decoded[1]!.ok && decoded[0]!.value.transportCapability !== decoded[1]!.value.transportCapability).toBe(true);
    expect(new URL(second.report.url).hash).not.toBe(new URL(first.report.url).hash);

    const renewed = await humanSession(second.report.url);
    const timeline = await call(second.report.origin, { path: `/api/v1/channels/${second.report.channelId}/timeline`, headers: renewed });
    expect(timeline.status).toBe(200);
    expect(timeline.text).toContain('kept across resume');
    // The old browser session died with the old server generation.
    await expect(call(first.report.origin, { path: '/' })).rejects.toBeTruthy();
  });

  it('refuses missing, malformed, and already-running resume targets without creating state', async () => {
    const root = makeRoot();
    expect(await launch(root, { request: { kind: 'resume', channelId: 'ch_missing' } })).toEqual({ kind: 'failed', code: 'missing_state' });
    expect(await launch(root, { request: { kind: 'resume', channelId: '../escape' } })).toEqual({ kind: 'failed', code: 'invalid_request' });
    expect(fs.readdirSync(path.join(root, 'channels'))).toEqual([]);
    expect(fs.existsSync(path.join(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE))).toBe(false);

    // A second launcher is refused at the root lease before it reaches the channel store lock.
    const launched = await running(root);
    expect(await launch(root, { request: { kind: 'resume', channelId: launched.report.channelId } }))
      .toEqual({ kind: 'failed', code: 'launcher_running' });
  });

  it('takes the root lease before touching runtime state, and a held lease wins over a free port', async () => {
    const root = makeRoot();
    const events: string[] = [];
    const launched = await running(root, { afterLease: () => events.push('leased') });
    expect(events).toEqual(['leased']);
    const before = fs.readFileSync(launched.report.descriptorPath);

    const secondEvents: string[] = [];
    const refused = await launch(root, { startPort: launched.report.port, afterLease: () => secondEvents.push('leased') });
    expect(refused).toEqual({ kind: 'failed', code: 'launcher_running' });
    expect(secondEvents).toEqual([]);
    expect(fs.readFileSync(launched.report.descriptorPath).equals(before)).toBe(true);
    expect(fs.readdirSync(path.join(root, 'channels'))).toHaveLength(1);
  });

  it('removes stale discovery and handoff files left by a launcher that no longer holds the lease', async () => {
    const root = makeRoot();
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(path.join(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE), 'stale', { mode: 0o600 });
    fs.mkdirSync(path.join(root, HANDOFF_DIRECTORY, 'handoff-old'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, HANDOFF_DIRECTORY, 'handoff-old', 'open.html'), 'stale', { mode: 0o600 });
    const launched = await running(root);
    expect(parseInternalDescriptor(fs.readFileSync(launched.report.descriptorPath, 'utf8')).ok).toBe(true);
    expect(fs.readdirSync(path.join(root, HANDOFF_DIRECTORY))).toEqual([]);
  });

  it('falls forward past an unrelated listener and reports it without secrets', async () => {
    const root = makeRoot();
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
    cleanups.push(() => new Promise<void>(resolve => blocker.close(() => resolve())));
    const busy = (blocker.address() as { port: number }).port;
    const launched = await running(root, { startPort: busy });
    expect(launched.report.port).toBeGreaterThan(busy);
    expect(launched.report.portFallback).toBe(true);
  });

  it('keeps a created channel and reports how to resume it when the server cannot start', async () => {
    const root = makeRoot();
    const broken = { ...webBundleManifest(fixtureBundle), entries: [{ route: '/api/x', file: 'index.html', contentType: 'text/html; charset=utf-8' as const }] };
    const failed = await launch(root, { assets: broken });
    expect(failed).toMatchObject({ kind: 'failed', code: 'server_failed', channelId: expect.stringMatching(/^ch_/) });
    if (failed.kind !== 'failed') return;
    expect(failed.resumeCommand).toBe(`khala internal --resume ${failed.channelId}`);
    expect(fs.existsSync(path.join(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE))).toBe(false);
    const resumed = await running(root, { request: { kind: 'resume', channelId: failed.channelId! } });
    expect(resumed.report.channelId).toBe(failed.channelId);
  });

  it('never lets a browser-open failure abort the launch, and removes an opened handoff on shutdown', async () => {
    const root = makeRoot();
    const throwing = await running(root, { openBrowser: async () => { throw new Error('ENOENT'); } });
    expect(throwing.report.browser).toEqual({ opened: false });
    await throwing.shutdown();

    let cleaned = 0;
    const opened = await running(root, {
      openBrowser: async input => {
        expect(input.handoffParent).toBe(path.join(root, HANDOFF_DIRECTORY));
        return { opened: true, profileId: 'proven', cleanup: async () => { cleaned += 1; } };
      },
    });
    expect(opened.report.browser).toEqual({ opened: true });
    await opened.shutdown();
    expect(cleaned).toBe(1);
  });
});
