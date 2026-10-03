import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StateError } from '../state';
import { runLocalCommand, type LocalCliDeps } from './cli';
const roomId = '!abcdefghijklmnopqrstuv:local';
const file = { v: 1 as const, origin: 'http://127.0.0.1:47830', port: 47830, pid: 123, version: 'old', adminToken: 'A'.repeat(43), startedAt: new Date().toISOString() };
function fixture(handler: (url: string, init?: RequestInit) => Response = () => Response.json({})) {
  const stdout = vi.fn(); const stderr = vi.fn();
  const ensureHelper = vi.fn(async () => file);
  const fetch = vi.fn(async (url, init) => handler(String(url), init)) as unknown as typeof globalThis.fetch;
  const deps: LocalCliDeps = { stdout, stderr, ensureHelper, fetch, now: () => new Date(2026, 9, 2).getTime() };
  return { deps, stdout, stderr, ensureHelper, fetch };
}
describe('local commands', () => {
  it('validates every command arity before starting the helper', async () => {
    const f = fixture();
    for (const argv of [[], ['bogus'], ['link'], ['delete'], ['list', 'x'], ['serve', 'x'], ['create', 'x', 'y'], ['status', 'x'], ['stop', 'x'], ['open', 'x', 'y']]) {
      expect(await runLocalCommand(argv, f.deps)).toBe(1);
      expect(f.stdout).toHaveBeenLastCalledWith('{"error":"invalid_arguments"}\n');
    }
    expect(f.ensureHelper).not.toHaveBeenCalled();
  });
  it('creates with a local-date default, bearer auth and a stderr-only web hint', async () => {
    const result = { roomId, name: 'local-2026-10-02', selfLink: 'self', shareLink: 'share', openUrl: 'open', expiresAt: 'later' };
    const f = fixture((url, init) => {
      if (url.endsWith('/')) return Response.json({ error: 'web_not_built' }, { status: 503 });
      expect(init?.headers).toEqual({ authorization: `Bearer ${file.adminToken}`, 'content-type': 'application/json' });
      expect(JSON.parse(init!.body as string)).toEqual({ name: 'local-2026-10-02' });
      return Response.json(result, { status: 201 });
    });
    expect(await runLocalCommand(['create'], f.deps)).toBe(0);
    expect(f.stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result) + '\n');
    expect(f.stderr).toHaveBeenCalledExactlyOnceWith('khala: web app not built; run pnpm --filter @khala/web build:local\n');
  });
  it('resolves exact names, rejects ambiguity and bypasses lookup for ids', async () => {
    for (const count of [0, 1, 2]) {
      const f = fixture(url => url.endsWith('/channels') ? Response.json({ revision: 7, channels: Array.from({ length: count }, () => ({ roomId, name: 'refactor' })) }) : Response.json({ shareLink: 'share', expiresAt: 'later' }));
      expect(await runLocalCommand(['link', 'refactor'], f.deps)).toBe(count === 1 ? 0 : 1);
      expect(f.stdout).toHaveBeenLastCalledWith(count === 1 ? '{"shareLink":"share","expiresAt":"later"}\n' : JSON.stringify({ error: count ? 'ambiguous_channel' : 'not_found' }) + '\n');
    }
    const f = fixture(url => { expect(url).toContain(encodeURIComponent(roomId) + '/links'); return Response.json({ shareLink: 'share' }); });
    expect(await runLocalCommand(['link', roomId], f.deps)).toBe(0);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('opens, lists and deletes using the owner endpoints', async () => {
    const f = fixture((url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/channels')) return Response.json({ revision: 3, channels: [{ roomId, name: 'refactor' }] });
      if (url.endsWith('/open')) { expect(JSON.parse(init!.body as string)).toEqual({ roomId }); return Response.json({ openUrl: 'url', expiresAt: 'later' }); }
      return new Response('index');
    });
    expect(await runLocalCommand(['open', 'refactor'], f.deps)).toBe(0);
    expect(f.stdout).toHaveBeenLastCalledWith('{"openUrl":"url","expiresAt":"later"}\n');
    expect(await runLocalCommand(['list'], f.deps)).toBe(0);
    expect(f.stdout).toHaveBeenLastCalledWith(JSON.stringify({ channels: [{ roomId, name: 'refactor' }] }) + '\n');
    expect(await runLocalCommand(['delete', 'refactor'], f.deps)).toBe(0);
    expect(f.stdout).toHaveBeenLastCalledWith(JSON.stringify({ deleted: roomId }) + '\n');
  });
  it('status and stop never start a helper and verify its pid', async () => {
    const f = fixture(url => url.endsWith('/healthz') ? Response.json({ ok: true, pid: 999, version: 'new' }) : Response.json({ channels: [] }));
    f.deps.readHelperFile = async () => file;
    for (const command of ['status', 'stop']) expect(await runLocalCommand([command], f.deps)).toBe(0);
    expect(f.stdout.mock.calls).toEqual([['{"running":false}\n'], ['{"stopped":false}\n']]);
    expect(f.ensureHelper).not.toHaveBeenCalled();
    f.deps.fetch = async () => Response.json({ ok: true, pid: file.pid, version: 'new', channels: [{ roomId }] });
    expect(await runLocalCommand(['status'], f.deps)).toBe(0);
    expect(f.stdout).toHaveBeenLastCalledWith(JSON.stringify({ running: true, origin: file.origin, pid: file.pid, version: 'new', channels: 1 }) + '\n');
    let shutdown = false;
    f.deps.fetch = async (_url, init) => {
      if (init?.method === 'POST') { shutdown = true; return new Response(null, { status: 204 }); }
      if (shutdown) throw new Error('closed');
      return Response.json({ ok: true, pid: file.pid, version: 'new' });
    };
    expect(await runLocalCommand(['stop'], f.deps)).toBe(0);
    expect(f.stdout).toHaveBeenLastCalledWith('{"stopped":true}\n');
  });
  it('maps connection, storage, route and malformed response errors without secrets', async () => {
    const f = fixture();
    for (const error of [new Error(file.adminToken), new StateError('unsafe_state_dir'), new StateError('storage_failed')]) {
      f.deps.ensureHelper = async () => { throw error; };
      expect(await runLocalCommand(['list'], f.deps)).toBe(1);
      expect(f.stdout).toHaveBeenLastCalledWith(JSON.stringify({ error: error instanceof StateError ? error.code : 'helper_unavailable' }) + '\n');
    }
    f.deps.ensureHelper = async () => file;
    for (const [response, code] of [[new Response('bad'), 'internal_error'], [Response.json({ error: 'forbidden' }, { status: 403 }), 'forbidden'], [Response.json({}, { status: 404 }), 'not_found']] as const) {
      f.deps.fetch = async () => response;
      expect(await runLocalCommand(['list'], f.deps)).toBe(1);
      expect(f.stdout).toHaveBeenLastCalledWith(JSON.stringify({ error: code }) + '\n');
    }
    f.deps.fetch = async () => { throw new Error(file.adminToken); };
    expect(await runLocalCommand(['list'], f.deps)).toBe(1);
    expect(f.stdout).toHaveBeenLastCalledWith('{"error":"helper_unavailable"}\n');
    expect(JSON.stringify([f.stdout.mock.calls, f.stderr.mock.calls])).not.toContain(file.adminToken);
  });
  it('opens the channel list and handles absent helpers without spawning', async () => {
    const f = fixture((url, init) => {
      if (url.endsWith('/open')) { expect(init?.body).toBe('{}'); return Response.json({ openUrl: 'url', expiresAt: 'later' }); }
      return new Response('index');
    });
    expect(await runLocalCommand(['open'], f.deps)).toBe(0);
    f.ensureHelper.mockClear(); f.deps.readHelperFile = async () => null;
    expect(await runLocalCommand(['status'], f.deps)).toBe(0);
    expect(await runLocalCommand(['stop'], f.deps)).toBe(0);
    expect(f.ensureHelper).not.toHaveBeenCalled();
    expect(f.stdout).toHaveBeenLastCalledWith('{"stopped":false}\n');
  });
  it('serves silently through the injected composition', async () => {
    const f = fixture(); f.deps.serve = vi.fn(async () => 0);
    expect(await runLocalCommand(['serve'], f.deps)).toBe(0);
    expect(f.stdout).not.toHaveBeenCalled();
  });
  it('runs the real binary with an isolated state directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ki137-bin-'));
    try {
      for (const [command, expected, code] of [['status', '{"running":false}\n', 0], ['frobnicate', '{"error":"invalid_arguments"}\n', 1]] as const) {
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [new URL('../../bin/khala.mjs', import.meta.url).pathname, 'local', command], { env: { ...process.env, XDG_STATE_HOME: root } });
          let stdout = ''; let stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
          child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
        });
        expect(result).toEqual({ code, stdout: expected, stderr: '' });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
