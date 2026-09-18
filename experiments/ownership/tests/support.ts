import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { startDisposableIdp, type DisposableIdp, type IdpAccount } from '../src/idp.ts';
import { startControl, type Control, type ControlOptions } from '../src/control.ts';

export type Stack = { control: Control; idp: DisposableIdp; close(): Promise<void> };

export async function startStack(accounts: IdpAccount[], options: Omit<ControlOptions, 'oidc'>): Promise<Stack> {
  let idp: DisposableIdp | undefined;
  const control = await startControl({
    ...options,
    oidc: () => ({ issuer: idp!.issuer, clientId: idp!.client.client_id, clientSecret: idp!.client.client_secret, allowInsecureLoopback: true }),
  });
  idp = await startDisposableIdp(accounts, control.callbackUrl);
  return { control, idp, close: async () => { await control.close(); await idp!.close(); } };
}

// The ordinary P06 sign-in: click "Sign in", type provider credentials.
export async function signIn(browser: Browser, stack: Stack, email: string, password: string) {
  browser.human('click "Sign in" on Khala');
  const form = await browser.navigate(`${stack.control.origin}/api/human/auth/login`);
  assert.equal(form.url.origin, stack.idp.issuer, 'sign-in must reach the identity provider');
  browser.human('enter email and password at the identity provider');
  const done = await browser.navigate(form.url.href, { method: 'POST', form: { email, password } });
  assert.equal(done.url.origin, stack.control.origin);
  return me(browser, stack);
}

export async function me(browser: Browser, stack: Stack): Promise<any> {
  const response = await browser.appRequest(`${stack.control.origin}/api/human/me`, 'GET', undefined);
  assert.equal(response.status, 200);
  return response.json();
}

export function tempStore(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `khala-ownership-${label}-`));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

export const fakeDeviceLogin = { issue: async (userId: string) => `login-for:${userId}` };
