import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';

type DisposableUserConfig = Readonly<{
  usernameEnv: string;
  passwordEnv: string;
}>;

type RawLiveEnvironment = Readonly<{
  environmentId: string;
  appOrigin: string;
  homeserverOrigin: string;
  synapseVersion: string;
  oauth: Readonly<{
    usernameLabel: string;
    usernamePlaceholder?: string;
    passwordLabel: string;
    submitName: string;
  }>;
  users: readonly [DisposableUserConfig, DisposableUserConfig];
  observer: Readonly<{
    userId: string;
    accessTokenEnv: string;
  }>;
}>;

export type LiveUser = Readonly<{ username: string; password: string }>;

export type LiveHumanEnvironment = Readonly<{
  environmentId: string;
  appOrigin: string;
  homeserverOrigin: string;
  synapseVersion: string;
  oauth: RawLiveEnvironment['oauth'];
  users: readonly [LiveUser, LiveUser];
  observer: Readonly<{ userId: string; accessToken: string }>;
}>;

function fail(message: string): never {
  throw new Error(`Invalid KHALA_E2E_DISPOSABLE_ENV: ${message}`);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a non-empty string`);
  return value;
}

function exactHttpsOrigin(value: unknown, field: string): string {
  const raw = nonEmpty(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${field} must be an exact https origin`);
  }
  if (url.protocol !== 'https:' || url.origin !== raw || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    fail(`${field} must be an exact https origin`);
  }
  return raw;
}

function secretFromEnv(name: unknown, field: string): string {
  const envName = nonEmpty(name, field);
  const value = process.env[envName];
  if (!value) fail(`${field} names an unset environment variable`);
  return value;
}

/**
 * Reads a secret-free JSON descriptor. Account passwords and the Matrix
 * observer token are referenced by environment-variable name so neither the
 * file nor Playwright output contains reusable credentials.
 */
export function readLiveHumanEnvironment(): LiveHumanEnvironment {
  const configPath = process.env.KHALA_E2E_DISPOSABLE_ENV;
  if (!configPath || !isAbsolute(configPath)) fail('must name an absolute JSON descriptor path');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch {
    return fail('must name readable JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('descriptor must be an object');
  const raw = parsed as Partial<RawLiveEnvironment>;
  if (!Array.isArray(raw.users) || raw.users.length !== 2) fail('users must contain exactly two disposable identities');
  if (typeof raw.oauth !== 'object' || raw.oauth === null) fail('oauth must describe the provider form');
  if (typeof raw.observer !== 'object' || raw.observer === null) fail('observer must describe a read-only Matrix account');

  const user = (entry: DisposableUserConfig, index: number): LiveUser => ({
    username: secretFromEnv(entry?.usernameEnv, `users[${index}].usernameEnv`),
    password: secretFromEnv(entry?.passwordEnv, `users[${index}].passwordEnv`),
  });

  return Object.freeze({
    environmentId: nonEmpty(raw.environmentId, 'environmentId'),
    appOrigin: exactHttpsOrigin(raw.appOrigin, 'appOrigin'),
    homeserverOrigin: exactHttpsOrigin(raw.homeserverOrigin, 'homeserverOrigin'),
    synapseVersion: nonEmpty(raw.synapseVersion, 'synapseVersion'),
    oauth: Object.freeze({
      usernameLabel: nonEmpty(raw.oauth.usernameLabel, 'oauth.usernameLabel'),
      ...(raw.oauth.usernamePlaceholder === undefined ? {} : {
        usernamePlaceholder: nonEmpty(raw.oauth.usernamePlaceholder, 'oauth.usernamePlaceholder'),
      }),
      passwordLabel: nonEmpty(raw.oauth.passwordLabel, 'oauth.passwordLabel'),
      submitName: nonEmpty(raw.oauth.submitName, 'oauth.submitName'),
    }),
    users: Object.freeze([
      Object.freeze(user(raw.users[0]!, 0)),
      Object.freeze(user(raw.users[1]!, 1)),
    ]) as readonly [LiveUser, LiveUser],
    observer: Object.freeze({
      userId: nonEmpty(raw.observer.userId, 'observer.userId'),
      accessToken: secretFromEnv(raw.observer.accessTokenEnv, 'observer.accessTokenEnv'),
    }),
  });
}

export async function signIn(page: Page, environment: LiveHumanEnvironment, user: LiveUser): Promise<void> {
  // A signed-out app route redirects straight to the provider; there is no Sign in page.
  const username = environment.oauth.usernamePlaceholder
    ? page.getByPlaceholder(environment.oauth.usernamePlaceholder)
    : page.getByLabel(environment.oauth.usernameLabel);
  await username.fill(user.username);
  await page.getByLabel(environment.oauth.passwordLabel).fill(user.password);
  await page.getByRole('button', { name: environment.oauth.submitName }).click();
  await page.waitForURL(url => url.origin === environment.appOrigin);
  // The profile gate loads asynchronously after OAuth. Wait for either setup
  // or the owner shell rather than checking setup before it has rendered.
  const setup = page.getByRole('heading', { name: 'Choose your username', exact: true });
  // The pending shell also has this button, disabled while the profile loads.
  const ready = page.getByRole('button', { name: 'New channel', exact: true }).and(page.locator(':enabled'));
  await expect(setup.or(ready)).toBeVisible({ timeout: 30_000 });
  if (await setup.isVisible()) {
    // Provider usernames may be email addresses. Choose a valid, unique Khala
    // name only for a fresh account; returning users keep their saved profile.
    await page.getByRole('textbox', { name: 'Username', exact: true })
      .fill(`e2e-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(ready).toBeVisible({ timeout: 30_000 });
  }
}

export async function freshPage(context: BrowserContext, environment: LiveHumanEnvironment): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${environment.appOrigin}/new`, { waitUntil: 'networkidle' });
  return page;
}

export function syntheticCanary(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function verifyMatrixObserver(environment: LiveHumanEnvironment): Promise<void> {
  const response = await fetch(`${environment.homeserverOrigin}/_matrix/client/v3/account/whoami`, {
    headers: { authorization: `Bearer ${environment.observer.accessToken}` },
  });
  if (!response.ok) throw new Error(`Matrix observer identity request failed with ${response.status}`);
  const body = await response.json() as { user_id?: unknown };
  if (body.user_id !== environment.observer.userId) throw new Error('Matrix observer identity does not match descriptor');
}

export async function rawRoomMessages(environment: LiveHumanEnvironment, roomId: string, accessToken: string): Promise<readonly Record<string, unknown>[]> {
  const response = await fetch(
    `${environment.homeserverOrigin}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error(`Matrix event request failed with ${response.status}`);
  const body = await response.json() as { chunk?: unknown };
  if (!Array.isArray(body.chunk)) throw new Error('Matrix observer response did not contain a chunk');
  return body.chunk.filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value));
}
