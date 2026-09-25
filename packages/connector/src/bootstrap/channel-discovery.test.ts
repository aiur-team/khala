import { createHash, generateKeyPairSync } from 'node:crypto';
import { type HarnessCapabilities, unknownModeSupportMap } from '@khala/contracts/delivery/index';
import { CHANNEL_DISCOVERY_SCOPES, type DiscoveryCredential } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_DISCOVERY_AUTHORIZE_PATH,
  CHANNEL_DISCOVERY_TOKEN_PATH,
  createChannelDiscoveryCredentialClient,
} from './channel-discovery';
import type { SessionInspection } from './ports';
import { createProofSigner } from './proof';

const ORIGIN = 'https://khala.example';
const OTHER_ORIGIN = 'https://preview.khala.example';
const T0 = Date.parse('2026-09-24T12:00:00Z');
const CLAIM = { harness: 'codex', sessionId: 'thread-existing-b', workdir: '/work/b' };
const SESSION = { harness: CLAIM.harness, sessionId: CLAIM.sessionId, generation: 3 };
const CAPABILITIES: HarnessCapabilities = {
  v: 3, harness: 'codex', version: '1.0.0', adapterVersion: '1', support: 'tested', existingSession: 'khala_hosted_resume',
  immediateNotification: 'khala_hosted_idle', busy: 'queue', receiptEvidence: [], reconcileByReleaseId: 'unknown',
  limits: { maxPayloadBytes: 1024, maxBatchItems: 1 } as never, evidenceRef: 'docs/evidence/codex.md',
  modes: unknownModeSupportMap('test-codex-interactive', 'Test fixture has no primary mode proof.', '1.0.0'),
  acknowledgement: 'unknown',
};
const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => T0);
const publicKey = JSON.parse(Buffer.from(signer.proof('POST', `${ORIGIN}/proof`).split('.')[0]!, 'base64url').toString()).jwk.x as string;

type Call = Readonly<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

function credential(overrides: Partial<DiscoveryCredential> = {}): DiscoveryCredential {
  return {
    v: 1,
    credentialRef: 'credential_current_123',
    audience: 'khala-channel-discovery',
    requester: {
      principal: 'stable_agent_123' as never,
      origin: ORIGIN,
      proofKey: { algorithm: 'Ed25519', publicKey, thumbprint: signer.jkt },
      sessionGeneration: SESSION.generation,
    },
    scopes: CHANNEL_DISCOVERY_SCOPES,
    expiresAt: new Date(T0 + 300_000).toISOString(),
    ...overrides,
  };
}

function service(reply: (call: Call) => Readonly<{ status: number; body?: unknown }> | Promise<Readonly<{ status: number; body?: unknown }>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    const response = await reply(call);
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function browser(outcome: 'allow' | 'deny' | 'ignore', seen: URL[] = [], pageBodies: string[] = []) {
  return async (url: string) => {
    const authorize = new URL(url);
    seen.push(authorize);
    if (outcome === 'ignore') return;
    const callback = new URL(authorize.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    if (outcome === 'allow') callback.searchParams.set('code', 'C'.repeat(43));
    else callback.searchParams.set('error', 'access_denied');
    const response = await fetch(callback);
    pageBodies.push(await response.text());
  };
}

function harness(overrides: Readonly<{
  inspect?: () => SessionInspection | Promise<SessionInspection>;
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  trustedOrigins?: readonly string[];
  timeoutMs?: number;
}> = {}) {
  const events: string[] = [];
  const client = createChannelDiscoveryCredentialClient({
    signer,
    sessions: {
      async inspect() {
        events.push('inspect');
        return overrides.inspect?.() ?? { kind: 'verified', session: SESSION, capabilities: CAPABILITIES };
      },
    },
    trustedOrigins: overrides.trustedOrigins ?? [ORIGIN],
    async openBrowser(url) {
      events.push('browser');
      await (overrides.openBrowser ?? browser('allow'))(url);
    },
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    timeoutMs: overrides.timeoutMs ?? 500,
    clock: () => T0,
  });
  return { client, events };
}

describe('createChannelDiscoveryCredentialClient', () => {
  it('inspects first, uses fixed endpoints and exchanges PKCE plus DPoP for a strict credential', async () => {
    const seen: URL[] = [];
    const pages: string[] = [];
    const { fetchImpl, calls } = service(() => ({ status: 200, body: { credential: credential() } }));
    const { client, events } = harness({ fetch: fetchImpl, openBrowser: browser('allow', seen, pages) });

    await expect(client.authorize({ origin: ORIGIN, session: CLAIM })).resolves.toEqual({ kind: 'authorized', credential: credential() });
    expect(events).toEqual(['inspect', 'browser']);
    expect(client.current()).toEqual(credential());
    const authorize = seen[0]!;
    expect(authorize.origin + authorize.pathname).toBe(`${ORIGIN}${CHANNEL_DISCOVERY_AUTHORIZE_PATH}`);
    expect(authorize.searchParams.get('proof_jkt')).toBe(signer.jkt);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(new URL(authorize.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
    expect(pages[0]).toContain('Channel discovery is authorized');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ORIGIN}${CHANNEL_DISCOVERY_TOKEN_PATH}`);
    expect(calls[0]!.headers.origin).toBe(ORIGIN);
    expect(calls[0]!.headers.dpop).toMatch(/^ey/u);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'authorization_code', code: 'C'.repeat(43), redirect_uri: authorize.searchParams.get('redirect_uri'),
      harness: SESSION.harness, session_id: SESSION.sessionId, generation: SESSION.generation,
    });
    expect(createHash('sha256').update(String(calls[0]!.body.code_verifier)).digest('base64url'))
      .toBe(authorize.searchParams.get('code_challenge'));
  });

  it('rejects an acceptable but unconfigured origin before inspecting or opening a browser', async () => {
    const { client, events } = harness();
    await expect(client.authorize({ origin: OTHER_ORIGIN, session: CLAIM })).resolves.toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    expect(events).toEqual([]);
  });

  it('maps denial, timeout and local cancellation to distinct finite outcomes without exchange', async () => {
    const denialPages: string[] = [];
    const deniedService = service(() => ({ status: 500 }));
    const denied = harness({ fetch: deniedService.fetchImpl, openBrowser: browser('deny', [], denialPages) });
    await expect(denied.client.authorize({ origin: ORIGIN, session: CLAIM })).resolves.toEqual({ kind: 'denied' });
    expect(denialPages[0]).toContain('Channel discovery was cancelled');
    expect(deniedService.calls).toHaveLength(0);

    const timedService = service(() => ({ status: 500 }));
    const timedUrls: URL[] = [];
    const timed = harness({ fetch: timedService.fetchImpl, openBrowser: browser('ignore', timedUrls), timeoutMs: 20 });
    await expect(timed.client.authorize({ origin: ORIGIN, session: CLAIM })).resolves.toEqual({ kind: 'timed_out' });
    expect(timedService.calls).toHaveLength(0);
    const late = new URL(timedUrls[0]!.searchParams.get('redirect_uri')!);
    late.searchParams.set('state', timedUrls[0]!.searchParams.get('state')!);
    late.searchParams.set('code', 'too_late');
    await expect(fetch(late)).rejects.toThrow();

    const cancelledService = service(() => ({ status: 500 }));
    const controller = new AbortController();
    const cancelled = harness({ fetch: cancelledService.fetchImpl, openBrowser: async () => controller.abort() });
    await expect(cancelled.client.authorize({ origin: ORIGIN, session: CLAIM }, { signal: controller.signal }))
      .resolves.toEqual({ kind: 'cancelled' });
    expect(cancelledService.calls).toHaveLength(0);
  });

  it('ignores cancellation after token exchange begins and reports a lost response as outcome unknown', async () => {
    const controller = new AbortController();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fetchImpl = (async () => {
      markStarted();
      await new Promise<void>(resolve => { release = resolve; });
      return new Response(JSON.stringify({ credential: credential() }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const { client } = harness({ fetch: fetchImpl });
    const authorization = client.authorize({ origin: ORIGIN, session: CLAIM }, { signal: controller.signal });
    await started;
    controller.abort();
    release();
    await expect(authorization).resolves.toMatchObject({ kind: 'authorized' });

    for (const failure of ['lost', 'unprovable'] as const) {
      let exchange = 0;
      const fetchImpl = (async () => {
        exchange += 1;
        if (exchange === 1) {
          return new Response(JSON.stringify({ credential: credential() }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (failure === 'lost') throw new Error('socket hang up');
        return new Response(JSON.stringify({ error: 'feature_unavailable' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      const repeated = harness({ fetch: fetchImpl });
      await expect(repeated.client.authorize({ origin: ORIGIN, session: CLAIM })).resolves.toMatchObject({ kind: 'authorized' });
      expect(repeated.client.current()).toEqual(credential());
      await expect(repeated.client.authorize({ origin: ORIGIN, session: CLAIM }))
        .resolves.toEqual({ kind: 'outcome_unknown' });
      expect(repeated.client.current()).toBeNull();
    }
  });

  it('ignores wrong-path, wrong-state, duplicate and mixed callbacks until one strict callback arrives', async () => {
    const answers: number[] = [];
    const { fetchImpl, calls } = service(() => ({ status: 200, body: { credential: credential() } }));
    const openBrowser = async (url: string) => {
      const authorize = new URL(url);
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
      const state = authorize.searchParams.get('state')!;
      const candidates = [
        new URL(`/?state=${state}&code=${'C'.repeat(43)}`, redirect),
        new URL(`${redirect.href}?state=forged&code=${'C'.repeat(43)}`),
        new URL(`${redirect.href}?state=${state}&state=${state}&code=${'C'.repeat(43)}`),
        new URL(`${redirect.href}?state=${state}&code=${'C'.repeat(43)}&code=${'D'.repeat(43)}`),
        new URL(`${redirect.href}?state=${state}&code=${'C'.repeat(43)}&error=access_denied`),
        new URL(`${redirect.href}?state=${state}&code=${'C'.repeat(43)}&extra=x`),
      ];
      for (const candidate of candidates) answers.push((await fetch(candidate)).status);
      const valid = new URL(redirect);
      valid.searchParams.set('state', state);
      valid.searchParams.set('code', 'C'.repeat(43));
      answers.push((await fetch(valid)).status);
    };
    const { client } = harness({ fetch: fetchImpl, openBrowser });
    await expect(client.authorize({ origin: ORIGIN, session: CLAIM })).resolves.toMatchObject({ kind: 'authorized' });
    expect(answers).toEqual([400, 400, 400, 400, 400, 400, 200]);
    expect(calls).toHaveLength(1);
  });

  it('rejects unsupported or mismatched native inspection before opening a browser', async () => {
    for (const [inspection, code] of [
      [{ kind: 'missing' }, 'session_missing'],
      [{ kind: 'unsupported' }, 'unsupported_harness'],
      [{ kind: 'verified', session: { ...SESSION, generation: 4 }, capabilities: { ...CAPABILITIES, existingSession: 'unknown' } }, 'unsupported_harness'],
    ] as const) {
      const { client, events } = harness({ inspect: () => inspection as SessionInspection });
      await expect(client.authorize({ origin: ORIGIN, session: CLAIM })).resolves.toEqual({ kind: 'rejected', code });
      expect(events).toEqual(['inspect']);
    }
  });

  it('rejects malformed or mismatched successful responses and never installs them', async () => {
    const invalid = [
      {},
      { credential: { ...credential(), audience: 'other' } },
      { credential: credential({ requester: { ...credential().requester, origin: OTHER_ORIGIN } }) },
      { credential: credential({ requester: { ...credential().requester, sessionGeneration: 4 } }) },
      { credential: credential({ requester: { ...credential().requester, proofKey: { ...credential().requester.proofKey, thumbprint: 'A'.repeat(43) } } }) },
      { credential: credential({ expiresAt: new Date(T0).toISOString() }) },
      { credential: { ...credential(), scopes: ['list_channels'] } },
    ];
    for (const body of invalid) {
      const { fetchImpl } = service(() => ({ status: 200, body }));
      const { client } = harness({ fetch: fetchImpl });
      await expect(client.authorize({ origin: ORIGIN, session: CLAIM })).resolves.toEqual({ kind: 'rejected', code: 'invalid_response' });
      expect(client.current()).toBeNull();
    }
  });

  it('reinspects and atomically replaces on refresh with an ath-bound proof', async () => {
    const next = credential({ credentialRef: 'credential_replacement_456', expiresAt: new Date(T0 + 400_000).toISOString() });
    let reply = credential();
    const { fetchImpl, calls } = service(() => ({ status: 200, body: { credential: reply } }));
    const { client, events } = harness({ fetch: fetchImpl });
    await client.authorize({ origin: ORIGIN, session: CLAIM });
    reply = next;
    await expect(client.refresh()).resolves.toEqual({ kind: 'refreshed', credential: next });
    expect(events).toEqual(['inspect', 'browser', 'inspect']);
    expect(client.current()).toEqual(next);
    const refresh = calls[1]!;
    expect(refresh.body).toEqual({ grant_type: 'refresh_token', harness: SESSION.harness, session_id: SESSION.sessionId, generation: SESSION.generation });
    expect(refresh.headers.authorization).toBe(`DPoP ${credential().credentialRef}`);
    const claims = JSON.parse(Buffer.from(refresh.headers.dpop!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.ath).toBe(createHash('sha256').update(credential().credentialRef).digest('base64url'));
  });

  it('clears local authority on a generation change, authoritative rejection or unknown rotation outcome', async () => {
    const responses = [
      { kind: 'generation' as const },
      { kind: 'status' as const, status: 401 },
      { kind: 'status' as const, status: 503 },
      { kind: 'lost' as const },
    ];
    for (const scenario of responses) {
      let refresh = false;
      const fetchImpl = (async () => {
        if (!refresh) return new Response(JSON.stringify({ credential: credential() }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
        if (scenario.kind === 'lost') throw new Error('socket hang up');
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: scenario.kind === 'status' ? scenario.status : 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      const inspection = () => refresh && scenario.kind === 'generation'
        ? { kind: 'verified' as const, session: { ...SESSION, generation: 4 }, capabilities: CAPABILITIES }
        : { kind: 'verified' as const, session: SESSION, capabilities: CAPABILITIES };
      const { client } = harness({ fetch: fetchImpl, inspect: inspection });
      await client.authorize({ origin: ORIGIN, session: CLAIM });
      refresh = true;
      const outcome = await client.refresh();
      expect(outcome.kind).toMatch(/^(rejected|outcome_unknown)$/u);
      expect(client.current()).toBeNull();
    }
  });

  it('keeps credentials process-local, starts empty after restart and supports explicit invalidation', async () => {
    const { fetchImpl } = service(() => ({ status: 200, body: { credential: credential() } }));
    const first = harness({ fetch: fetchImpl }).client;
    await first.authorize({ origin: ORIGIN, session: CLAIM });
    expect(first.current()).toEqual(credential());
    expect(harness({ fetch: fetchImpl }).client.current()).toBeNull();
    first.invalidate();
    expect(first.current()).toBeNull();
  });
});
