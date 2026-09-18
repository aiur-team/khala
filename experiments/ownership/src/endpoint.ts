// Owner endpoint run by the agent's existing session on the owner's machine.
// It holds its own key and Matrix device; nothing here requires human setup.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from 'jose';
import type { BootstrapResult, SessionClaim } from './binding.ts';

export type EndpointKey = { privateKey: CryptoKey; publicJwk: JWK; jkt: string };

// Endpoint identity persists across restarts in an owner-only directory.
export async function loadOrCreateKey(storeDir: string): Promise<EndpointKey> {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  chmodSync(storeDir, 0o700);
  const file = join(storeDir, 'endpoint-key.json');
  let privateJwk: JWK;
  if (existsSync(file)) privateJwk = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = await exportJWK(privateKey);
    writeFileSync(file, JSON.stringify(privateJwk), { mode: 0o600 });
  }
  const { d: _secret, ...publicJwk } = privateJwk;
  return { privateKey: await importJWK(privateJwk, 'EdDSA') as CryptoKey, publicJwk, jkt: await calculateJwkThumbprint(publicJwk) };
}

export async function proofFor(key: EndpointKey, method: string, url: string, accessToken?: string): Promise<string> {
  const claims: Record<string, string> = { htm: method, htu: url };
  if (accessToken) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
  return new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: key.publicJwk })
    .setIssuedAt().setJti(randomBytes(16).toString('hex')).sign(key.privateKey);
}

export type EndpointOptions = {
  trustedOrigin: string;
  // Supplied by the harness adapter (KHA-103/104); absent means unsupported.
  session: SessionClaim | undefined;
  // Opens the owner's default browser on this machine.
  openBrowser(url: string): Promise<unknown>;
  storeDir: string;
  operationId?: string;
  homeserver?: string;
  transport?: typeof fetch;
  timeoutMs?: number;
};

export type EndpointResult =
  | { status: 'blocked'; reason: string }
  | { status: 'connected'; result: BootstrapResult; key: EndpointKey; matrix?: { userId: string; deviceId: string; accessToken: string } };

async function post(transport: typeof fetch, url: string, body: unknown, headers: Record<string, string>) {
  const response = await transport(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error ?? `HTTP ${response.status}`), { code: json.error, status: response.status });
  return json;
}

export async function connectFromLink(chatUrl: string, options: EndpointOptions): Promise<EndpointResult> {
  const transport = options.transport ?? fetch;
  const link = new URL(chatUrl);
  if (link.origin !== options.trustedOrigin) return { status: 'blocked', reason: 'untrusted_origin' };
  // Report the unsupported prerequisite instead of starting a fresh conversation.
  if (!options.session) return { status: 'blocked', reason: 'harness_session_missing' };
  const descriptorResponse = await transport(link, { headers: { accept: 'application/json' }, redirect: 'error' });
  if (!descriptorResponse.ok) return { status: 'blocked', reason: 'unknown_link' };
  const descriptor = await descriptorResponse.json();
  if (descriptor.version !== 1 || !descriptor.methods?.includes('loopback-browser-v1') || new URL(descriptor.bind).origin !== options.trustedOrigin) {
    return { status: 'blocked', reason: 'unsupported_descriptor' };
  }
  const key = await loadOrCreateKey(options.storeDir);
  const state = randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const callbackPath = `/khala/callback/${randomBytes(8).toString('hex')}`;
  let deliver!: (code: string) => void;
  let reject!: (error: Error) => void;
  const received = new Promise<string>((resolve, fail) => { deliver = resolve; reject = fail; });
  const listener = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== callbackPath || url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end('<p>Your agent is connected. You can close this tab.</p>');
    deliver(url.searchParams.get('code')!);
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const timer = setTimeout(() => reject(new Error('owner_browser_timeout')), options.timeoutMs ?? 120_000);
  try {
    const bind = new URL(descriptor.bind);
    bind.search = new URLSearchParams({
      link: descriptor.link, session: Buffer.from(JSON.stringify(options.session)).toString('base64url'), jkt: key.jkt,
      redirect_uri: `http://127.0.0.1:${(listener.address() as AddressInfo).port}${callbackPath}`,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), state,
    }).toString();
    const opened = options.openBrowser(bind.href);
    let code: string;
    try { code = await received; } catch (error) {
      await opened.catch(() => undefined);
      return { status: 'blocked', reason: (error as Error).message };
    }
    await opened;
    const tokenUrl = `${options.trustedOrigin}/api/agent/bind/token`;
    const { bootstrap_token: token } = await post(transport, tokenUrl, { code, code_verifier: codeVerifier, session: options.session }, { dpop: await proofFor(key, 'POST', tokenUrl) });
    const redeemUrl = `${options.trustedOrigin}/api/agent/bootstrap/redeem`;
    const operationId = options.operationId ?? randomBytes(12).toString('base64url');
    let result: BootstrapResult | undefined;
    let failure: unknown;
    // Retries keep the original operation ID; each attempt carries a fresh proof.
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        result = await post(transport, redeemUrl, { session: options.session, operation_id: operationId }, {
          authorization: `DPoP ${token}`, dpop: await proofFor(key, 'POST', redeemUrl, token),
        });
      } catch (error) {
        failure = error;
        if ((error as { status?: number }).status) break;
      }
    }
    if (!result) throw failure;
    if (!options.homeserver) return { status: 'connected', result, key };
    const deviceId = `KHALA${randomBytes(5).toString('hex').toUpperCase()}`;
    const login = await post(fetch, `${options.homeserver}/_matrix/client/v3/login`, {
      type: 'org.matrix.login.jwt', token: result.deviceLogin.loginToken, device_id: deviceId, initial_device_display_name: `Khala ${options.session.harness} endpoint`,
    }, {});
    return { status: 'connected', result, key, matrix: { userId: login.user_id, deviceId: login.device_id, accessToken: login.access_token } };
  } finally {
    clearTimeout(timer);
    listener.closeAllConnections();
    listener.close();
  }
}
