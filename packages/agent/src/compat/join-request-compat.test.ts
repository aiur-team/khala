import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKhalaAgentClient } from '../client-impl';
import { requestJoin } from '../join';
import { frozenMainControlJoinValidation } from './control-join-request.main.frozen';
import { frozenMainHelperJoinValidation } from './helper-join-request.main.frozen';

// A rejoin-capable CLI can be released before the control plane that understands
// `sessionId`/`rejoinSecret` is deployed, and it can meet a machine-wide helper
// started by an older CLI. Both pre-#1076 validators reject any extra join field with
// 400 invalid_link. The client must then fall back to the original three-field body
// (a fresh "-N" member) instead of failing every join.

const SECRET = 'S'.repeat(43);
const created = (origin: string) => ({ joinId: 'j'.repeat(22), pollSecret: 'p'.repeat(43), confirmUrl: `${origin}/agent/confirm?joinId=${'j'.repeat(22)}`, expiresAt: '2026-10-04T00:10:00.000Z' });
type Validate = (request: Request) => Promise<{ status: number; json: { error: string } } | 'accepted'>;

function server(origin: string, validate: Validate) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    bodies.push(await request.clone().json() as Record<string, unknown>);
    const verdict = await validate(request);
    return verdict === 'accepted' ? Response.json(created(origin), { status: 201 }) : Response.json(verdict.json, { status: verdict.status });
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}
const hosted = 'https://khala.example';
const local = 'http://127.0.0.1:47830';
const servers: Record<string, { origin: string; link: string; validate: Validate }> = {
  'production control plane (main 120d9ffa)': { origin: hosted, link: `${hosted}/join/${'a'.repeat(43)}`, validate: frozenMainControlJoinValidation },
  'already-running helper (main 120d9ffa)': { origin: local, link: `${local}/join/${'a'.repeat(43)}`,
    validate: async request => frozenMainHelperJoinValidation({ body: await request.json() }, { origin: local }) },
};

describe.each(Object.entries(servers))('a rejoin-capable CLI against the %s', (_name, target) => {
  it('falls back once to the three-field join body', async () => {
    const { fetch, bodies } = server(target.origin, target.validate);
    await expect(requestJoin({ link: target.link, harness: 'codex', label: 'Codex', sessionId: 'thread-1', rejoinSecret: SECRET }, { fetch }))
      .resolves.toMatchObject({ joinId: 'j'.repeat(22), origin: target.origin });
    expect(bodies).toEqual([
      { link: target.link, harness: 'codex', label: 'Codex', sessionId: 'thread-1', rejoinSecret: SECRET },
      { link: target.link, harness: 'codex', label: 'Codex' },
    ]);
  });

  it('still reports a genuinely invalid join after the single fallback', async () => {
    const invalid = server(target.origin, async () => ({ status: 400, json: { error: 'invalid_link' } }));
    await expect(requestJoin({ link: target.link, harness: 'codex', label: 'Codex', sessionId: 'thread-1', rejoinSecret: SECRET }, { fetch: invalid.fetch }))
      .rejects.toMatchObject({ code: 'invalid_link' });
    expect(invalid.bodies).toHaveLength(2);
  });
});

describe('a server that understands rejoin', () => {
  it('gets the rejoin fields in a single request', async () => {
    const { fetch, bodies } = server(hosted, async () => 'accepted');
    await requestJoin({ link: servers['production control plane (main 120d9ffa)']!.link, harness: 'codex', label: 'Codex', sessionId: 'thread-1', rejoinSecret: SECRET }, { fetch });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ sessionId: 'thread-1', rejoinSecret: SECRET });
  });

  it('never retries a three-field join', async () => {
    const { fetch, bodies } = server(hosted, async () => ({ status: 400, json: { error: 'invalid_link' } }));
    await expect(requestJoin({ link: servers['production control plane (main 120d9ffa)']!.link, harness: 'codex', label: 'Codex' }, { fetch }))
      .rejects.toMatchObject({ code: 'invalid_link' });
    expect(bodies).toHaveLength(1);
  });
});

describe('the agent client against the production control plane', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it('reaches the confirmation step instead of failing the join', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-join-compat-'));
    const target = servers['production control plane (main 120d9ffa)']!;
    const { fetch, bodies } = server(hosted, target.validate);
    const client = createKhalaAgentClient({ harness: 'codex', sessionId: 'thread-1', env: { XDG_STATE_HOME: root }, fetch,
      joinApi: { requestJoin, pollJoin: (_input, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))), reportReady: async () => {} } });
    try {
      expect(await client.join(target.link, 'Codex')).toMatchObject({ state: 'awaiting_confirmation' });
      expect(bodies.map(body => Object.keys(body).sort())).toEqual([
        ['harness', 'label', 'link', 'rejoinSecret', 'sessionId'], ['harness', 'label', 'link'],
      ]);
    } finally { await client.close(); }
  });
});

describe('new harnesses against frozen servers', () => {
  const input = { harness: 'gemini', label: 'Gemini' } as const;
  it('restarts the local helper once then retries the same link', async () => {
    let upgraded = false;
    const target = servers['already-running helper (main 120d9ffa)']!;
    const fake = server(local, request => upgraded ? Promise.resolve('accepted') : target.validate(request));
    const restartHelper = vi.fn(async () => { upgraded = true; return true; });
    await expect(requestJoin({ ...input, link: target.link }, { fetch: fake.fetch, restartHelper })).resolves.toMatchObject({ origin: local });
    expect(restartHelper).toHaveBeenCalledExactlyOnceWith(local);
    expect(fake.bodies).toHaveLength(2);
    expect(fake.bodies[0]).toEqual(fake.bodies[1]);
  });
  it('surfaces a second local rejection', async () => {
    const target = servers['already-running helper (main 120d9ffa)']!;
    const fake = server(local, target.validate);
    const restartHelper = vi.fn(async () => true);
    await expect(requestJoin({ ...input, link: target.link }, { fetch: fake.fetch, restartHelper })).rejects.toMatchObject({ message: 'invalid_harness' });
    expect(restartHelper).toHaveBeenCalledOnce();
    expect(fake.bodies).toHaveLength(2);
  });
  it('surfaces local rejection when the restart allowance is spent', async () => {
    const target = servers['already-running helper (main 120d9ffa)']!;
    const fake = server(local, target.validate);
    await expect(requestJoin({ ...input, link: target.link }, { fetch: fake.fetch, restartHelper: async () => false })).rejects.toMatchObject({ message: 'invalid_harness' });
    expect(fake.bodies).toHaveLength(1);
  });
  it('explains hosted version skew using the harness display name', async () => {
    const target = servers['production control plane (main 120d9ffa)']!;
    const fake = server(hosted, target.validate);
    const restartHelper = vi.fn(async () => true);
    await expect(requestJoin({ ...input, link: target.link }, { fetch: fake.fetch, restartHelper })).rejects.toMatchObject({
      code: 'update_required', message: "Khala's hosted service does not accept Gemini CLI agents yet. Local channels work now.",
    });
    expect(fake.bodies).toHaveLength(1);
    expect(restartHelper).not.toHaveBeenCalled();
  });
});

it('retains rejoin identity after a frozen helper rejects the new harness', async () => {
  const target = servers['already-running helper (main 120d9ffa)']!;
  let upgraded = false;
  const fake = server(local, request => upgraded ? Promise.resolve('accepted') : target.validate(request));
  const restartHelper = vi.fn(async () => { upgraded = true; return true; });
  await requestJoin({ link: target.link, harness: 'gemini', label: 'Gemini', sessionId: 'thread-1', rejoinSecret: SECRET }, { fetch: fake.fetch, restartHelper });
  expect(fake.bodies).toEqual([
    { link: target.link, harness: 'gemini', label: 'Gemini', sessionId: 'thread-1', rejoinSecret: SECRET },
    { link: target.link, harness: 'gemini', label: 'Gemini' },
    { link: target.link, harness: 'gemini', label: 'Gemini', sessionId: 'thread-1', rejoinSecret: SECRET },
  ]);
  expect(restartHelper).toHaveBeenCalledOnce();
});
