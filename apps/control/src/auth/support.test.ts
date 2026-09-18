// Test doubles for the auth module's injected ports, plus checks that the doubles
// keep the contract semantics the module relies on. Doubles prove module
// behaviour only, never a provider or store capability.

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CompareAndSetInput, type ControlRecord, type ControlStore, type JsonValue, type OwnerId, isRecordLive, sameJsonValue,
} from '@khala/contracts/messaging/index';
import { type AuthService, type AuthServiceOptions, createAuthService } from './index';
import type { AuthorizationRequest, CodeExchange, OidcClient, ProviderResult } from './provider';
import type { MessagingAccountDirectory } from './provisioning';

export const ORIGIN = 'https://khala.aiur.team';
export const ISSUER = 'https://id.example.test';
export const CLIENT_ID = 'khala-web';
export const T0 = Date.parse('2026-09-17T12:00:00Z');

type Fault = 'unavailable' | 'lose_response' | 'throw';

/** ControlStore double with per-key CAS, operation identity, expiry and injectable faults. */
export function fakeStore(clock: () => number) {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, { key: string; next: CompareAndSetInput['next']; record: ControlRecord }>();
  const faults: Partial<Record<'read' | 'compareAndSet' | 'resolve', Fault[]>> = {};
  let revision = 0;
  const take = (op: keyof typeof faults) => faults[op]?.shift();
  const live = (key: string) => {
    const record = records.get(key);
    return record && isRecordLive(record, clock()) ? record : null;
  };
  const store: ControlStore = {
    async read<T extends JsonValue>(key: string) {
      const fault = take('read');
      if (fault === 'throw') throw new Error('store exploded: secret-cookie-value');
      if (fault) return { kind: 'unavailable' as const };
      const record = live(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const fault = take('compareAndSet');
      if (fault === 'throw') throw new Error('store exploded');
      if (fault === 'unavailable') return { kind: 'unavailable' as const };
      const previous = operations.get(input.operationId);
      if (previous) {
        const identical = previous.key === input.key && previous.next.expiresAt === input.next.expiresAt
          && sameJsonValue(previous.next.value, input.next.value);
        return identical ? { kind: 'applied' as const, record: previous.record as ControlRecord<T> } : { kind: 'operation_mismatch' as const };
      }
      const current = live(input.key);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict' as const, current: current as ControlRecord<T> | null };
      }
      revision += 1;
      const record: ControlRecord<T> = {
        key: input.key, revision: `r${revision}`, operationId: input.operationId, value: structuredClone(input.next.value), expiresAt: input.next.expiresAt,
      };
      records.set(input.key, record);
      operations.set(input.operationId, { key: input.key, next: input.next, record });
      return fault === 'lose_response'
        ? { kind: 'outcome_unknown' as const, operationId: input.operationId }
        : { kind: 'applied' as const, record };
    },
    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      if (take('resolve')) return { kind: 'unavailable' as const };
      const operation = operations.get(input.operationId);
      if (!operation || operation.key !== input.key) return { kind: 'not_applied' as const };
      return { kind: 'applied' as const, record: operation.record as ControlRecord<T> };
    },
  };
  return {
    store,
    records,
    inject(op: keyof typeof faults, ...modes: Fault[]) {
      faults[op] = [...(faults[op] ?? []), ...modes];
    },
    keys: (prefix: string) => [...records.keys()].filter(key => key.startsWith(prefix)),
  };
}

export type Claims = Record<string, unknown>;

/**
 * OIDC client double. It stands in for the maintained library and enforces the
 * same bindings: S256 PKCE only, and a code redeemed only with the state,
 * redirect URI, verifier and nonce of the request that issued it. Tests set the
 * claims it returns; the ID token carries the issued nonce unless a test
 * overrides it to model an adapter that skipped its nonce check.
 */
export function fakeOidc() {
  const issued: AuthorizationRequest[] = [];
  let claims: Claims | null = null;
  let next: ProviderResult<Claims> | 'throw' | null = null;
  const exchanges: CodeExchange[] = [];
  const invalid = { kind: 'rejected', code: 'invalid_response' } as const;
  const client: OidcClient = {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    async authorizationUrl(request) {
      if (request.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)) return invalid;
      issued.push(request);
      const url = new URL(`${ISSUER}/authorize`);
      url.search = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: request.redirectUri, response_type: 'code', state: request.state,
        nonce: request.nonce, code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod,
      }).toString();
      return { kind: 'ok', value: url.href };
    },
    async exchangeCode(exchange) {
      exchanges.push(exchange);
      const result = next;
      next = null;
      if (result === 'throw') throw new Error('provider exploded: id_token=eyJsecret');
      if (result) return result;
      const state = new URL(exchange.callbackUrl).searchParams.get('state');
      const grant = issued.find(request => request.state === state);
      if (!grant || exchange.expectedState !== grant.state) return invalid;
      if (exchange.redirectUri !== grant.redirectUri) return invalid;
      if (createHash('sha256').update(exchange.codeVerifier).digest('base64url') !== grant.codeChallenge) return invalid;
      if (exchange.nonce !== grant.nonce) return invalid;
      return { kind: 'ok', value: { nonce: grant.nonce, ...claims } };
    },
  };
  return {
    client,
    issued,
    exchanges,
    signInAs(subject: string, email: string, extra: Claims = {}) {
      claims = { iss: ISSUER, aud: CLIENT_ID, sub: subject, email, email_verified: true, exp: T0 / 1000 + 3600, iat: T0 / 1000, ...extra };
    },
    setClaims(value: Claims) {
      claims = value;
    },
    failNext(result: ProviderResult<Claims> | 'throw') {
      next = result;
    },
  };
}

type DirectoryFault = 'unavailable' | 'lose_create_response' | 'throw';

/** Messaging account directory double keyed by external ID. */
export function fakeDirectory() {
  const accounts = new Map<string, string>();
  const faults: { lookup: DirectoryFault[]; create: DirectoryFault[] } = { lookup: [], create: [] };
  let creates = 0;
  const directory: MessagingAccountDirectory = {
    async lookup(externalId: OwnerId) {
      const fault = faults.lookup.shift();
      if (fault === 'throw') throw new Error('directory exploded');
      if (fault) return { kind: 'unavailable' };
      const accountId = accounts.get(externalId);
      return accountId ? { kind: 'found', accountId } : { kind: 'absent' };
    },
    async create(externalId: OwnerId) {
      const fault = faults.create.shift();
      if (fault === 'throw') throw new Error('directory exploded');
      if (fault === 'unavailable') return { kind: 'unavailable' };
      creates += 1;
      const accountId = accounts.get(externalId) ?? `@khala_${creates}:messaging.test`;
      accounts.set(externalId, accountId);
      return fault === 'lose_create_response' ? { kind: 'outcome_unknown' } : { kind: 'created', accountId };
    },
  };
  return {
    directory,
    accounts,
    creates: () => creates,
    inject(op: 'lookup' | 'create', ...modes: DirectoryFault[]) {
      faults[op].push(...modes);
    },
  };
}

export const secureRandom = (bytes: number) => new Uint8Array(randomBytes(bytes));

export function harness(overrides: Partial<AuthServiceOptions> = {}) {
  let now = T0;
  const clock = () => now;
  const store = fakeStore(clock);
  const oidc = fakeOidc();
  const messaging = fakeDirectory();
  const logs: unknown[] = [];
  const service: AuthService = createAuthService({
    oidc: oidc.client,
    store: store.store,
    messaging: messaging.directory,
    clock,
    random: secureRandom,
    origin: ORIGIN,
    sessionTtlMs: 8 * 3600_000,
    loginTtlMs: 600_000,
    log: entry => logs.push(entry),
    ...overrides,
  });
  return {
    service, store, oidc, messaging, logs,
    advance(ms: number) {
      now += ms;
    },
  };
}

export type Harness = ReturnType<typeof harness>;

type RequestInit = { method?: string; cookies?: string[]; headers?: Record<string, string>; body?: string };

export function request(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.cookies?.length) headers.set('cookie', init.cookies.join('; '));
  return new Request(new URL(url, ORIGIN), { method: init.method ?? 'GET', headers, ...(init.body ? { body: init.body } : {}) });
}

/** `name=value` pairs from Set-Cookie strings, ready to send back. */
export function cookiePairs(setCookies: readonly string[]): string[] {
  return setCookies.map(cookie => cookie.split(';')[0]!).filter(pair => !pair.endsWith('='));
}

/** Runs begin → provider → callback and returns the callback request, ready to deliver. */
export async function beginAndReturn(h: Harness, returnPath = '/chats') {
  const started = await h.service.startSignIn(returnPath);
  if (started.kind !== 'redirect') throw new Error(`sign-in did not start: ${started.kind}`);
  const state = new URL(started.location).searchParams.get('state')!;
  return request(`/api/human/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, { cookies: cookiePairs(started.cookies) });
}

/** Full sign-in; returns the session cookie pair and the signed-in result. */
export async function signIn(h: Harness, subject = 'user-1', email = 'ada@example.test') {
  h.oidc.signInAs(subject, email);
  const result = await h.service.completeSignIn(await beginAndReturn(h));
  if (result.kind !== 'signed_in') throw new Error(`sign-in failed: ${JSON.stringify(result)}`);
  return { result, cookies: cookiePairs(result.cookies) };
}

describe('test doubles', () => {
  it('store double enforces create-if-absent and operation identity', async () => {
    const { store } = fakeStore(() => T0);
    const input = { key: 'k', expectedRevision: null, operationId: 'op', next: { value: 1, expiresAt: null } };
    expect((await store.compareAndSet(input)).kind).toBe('applied');
    expect((await store.compareAndSet(input)).kind).toBe('applied');
    expect((await store.compareAndSet({ ...input, next: { value: 2, expiresAt: null } })).kind).toBe('operation_mismatch');
    expect((await store.compareAndSet({ ...input, operationId: 'op2' })).kind).toBe('conflict');
  });

  it.each([
    ['another state', { expectedState: 'x'.repeat(43) }],
    ['another redirect URI', { redirectUri: `${ORIGIN}/elsewhere` }],
    ['another code verifier', { codeVerifier: 'v'.repeat(43) }],
    ['another nonce', { nonce: 'n'.repeat(43) }],
  ])('provider double refuses a code redeemed with %s', async (_name, change) => {
    const oidc = fakeOidc();
    oidc.signInAs('user-1', 'ada@example.test');
    const verifier = 'c'.repeat(43);
    const grant = {
      redirectUri: `${ORIGIN}/api/human/auth/callback`, state: 's'.repeat(43), nonce: 'o'.repeat(43),
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' as const,
    };
    expect((await oidc.client.authorizationUrl(grant)).kind).toBe('ok');
    const exchange = {
      callbackUrl: `${grant.redirectUri}?code=c&state=${grant.state}`, redirectUri: grant.redirectUri,
      expectedState: grant.state, nonce: grant.nonce, codeVerifier: verifier,
    };
    expect(await oidc.client.exchangeCode(exchange)).toMatchObject({ kind: 'ok', value: { nonce: grant.nonce } });
    expect(await oidc.client.exchangeCode({ ...exchange, ...change })).toEqual({ kind: 'rejected', code: 'invalid_response' });
  });

  it('provider double refuses plain PKCE', async () => {
    const request = { redirectUri: ORIGIN, state: 's', nonce: 'n', codeChallenge: 'c'.repeat(43), codeChallengeMethod: 'plain' };
    expect(await fakeOidc().client.authorizationUrl(request as unknown as AuthorizationRequest))
      .toEqual({ kind: 'rejected', code: 'invalid_response' });
  });

  it('store double hides expired records', async () => {
    let now = T0;
    const { store } = fakeStore(() => now);
    await store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next: { value: 1, expiresAt: new Date(T0 + 1000).toISOString() } });
    now += 1000;
    expect((await store.read('k')).kind).toBe('absent');
  });
});
