#!/usr/bin/env node

// Real local Dex/browser proof. It never prints credentials, tokens, or URLs
// containing OAuth codes. Do not point this at a hosted or production issuer.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { readInputs } from './render-dex.ts';

const inputs = readInputs(process.env);
const issuer = new URL(inputs.issuer);
const callback = new URL(inputs.callback);
if (issuer.protocol !== 'http:' || issuer.hostname !== '127.0.0.1' ||
    callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1') {
  throw new Error('OIDC smoke is loopback-only');
}
const password = process.env.KHALA_PREVIEW_OIDC_USER_A_PASSWORD;
if (!password) throw new Error('Missing disposable OIDC user A password');

const metadataResponse = await fetch(`${inputs.issuer}/.well-known/openid-configuration`);
assert.equal(metadataResponse.status, 200);
const metadata = await metadataResponse.json() as Record<string, unknown>;
assert.equal(metadata.issuer, inputs.issuer);
assert.ok(Array.isArray(metadata.code_challenge_methods_supported) && metadata.code_challenge_methods_supported.includes('S256'));
const jwksResponse = await fetch(String(metadata.jwks_uri));
assert.equal(jwksResponse.status, 200);
const jwks = await jwksResponse.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
assert.ok(jwks.keys?.length);

const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');
const nonce = randomBytes(16).toString('base64url');
const authorization = new URL(String(metadata.authorization_endpoint));
for (const [name, value] of Object.entries({
  client_id: inputs.clientId,
  redirect_uri: inputs.callback,
  response_type: 'code',
  scope: 'openid email',
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: 'S256',
})) authorization.searchParams.set(name, value);

const browser = await chromium.launch({ headless: true });
let returnedCallback: string | null = null;
const callbackServer = createServer((request, response) => {
  const requested = new URL(request.url ?? '/', callback.origin);
  if (requested.pathname !== callback.pathname) {
    response.writeHead(404).end();
    return;
  }
  returnedCallback = requested.href;
  response.writeHead(200, { 'content-type': 'text/plain' }).end('Disposable OIDC callback captured');
});
try {
  await new Promise<void>((resolve, reject) => {
    callbackServer.once('error', reject);
    callbackServer.listen(Number(callback.port), callback.hostname, resolve);
  });
  const page = await browser.newPage();
  await page.goto(authorization.href);
  await page.getByPlaceholder('email address').fill(inputs.users[0].email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(url => url.origin === callback.origin && url.pathname === callback.pathname);
} finally {
  await browser.close();
  callbackServer.close();
}
assert.ok(returnedCallback);
const params = new URL(returnedCallback).searchParams;
assert.equal(params.get('state'), state);
const code = params.get('code');
assert.ok(code);

const tokenResponse = await fetch(String(metadata.token_endpoint), {
  method: 'POST',
  headers: {
    authorization: `Basic ${Buffer.from(`${inputs.clientId}:${inputs.clientSecret}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: inputs.callback, code_verifier: verifier }),
});
assert.equal(tokenResponse.status, 200);
const tokens = await tokenResponse.json() as { id_token?: unknown };
assert.equal(typeof tokens.id_token, 'string');
const [headerPart, payloadPart, signaturePart] = (tokens.id_token as string).split('.');
assert.ok(headerPart && payloadPart && signaturePart);
const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
assert.equal(header.alg, 'RS256');
const key = jwks.keys.find(candidate => candidate.kid === header.kid);
assert.ok(key);
assert.ok(verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signaturePart, 'base64url')));
assert.equal(claims.iss, inputs.issuer);
assert.equal(claims.aud, inputs.clientId);
assert.equal(claims.nonce, nonce);
assert.equal(claims.email, inputs.users[0].email);
assert.equal(claims.email_verified, true);
assert.ok(typeof claims.exp === 'number' && claims.exp > Date.now() / 1000);
process.stdout.write(JSON.stringify({ discovery: 'passed', jwksSignature: 'passed', pkceS256: 'passed', verifiedEmail: true }) + '\n');
