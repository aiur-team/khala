#!/usr/bin/env node

// Render a disposable Dex issuer. The output contains client and password-hash
// credentials; keep its parent private and never commit or print the file.
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Inputs = Readonly<{
  issuer: string;
  callback: string;
  clientId: string;
  clientSecret: string;
  users: readonly [Readonly<{ email: string; hash: string; id: string }>, Readonly<{ email: string; hash: string; id: string }>];
  configDir: string;
}>;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function url(value: string, loopbackAllowed: boolean): URL {
  const parsed = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash || parsed.search ||
      (parsed.protocol !== 'https:' && !(loopbackAllowed && parsed.protocol === 'http:' && loopback))) {
    throw new Error('OIDC URLs must use HTTPS, except for loopback preflight');
  }
  return parsed;
}

export function readInputs(env: NodeJS.ProcessEnv): Inputs {
  const issuer = required(env, 'KHALA_PREVIEW_OIDC_ISSUER');
  const callback = required(env, 'KHALA_PREVIEW_OIDC_CALLBACK');
  const issuerUrl = url(issuer, true);
  const callbackUrl = url(callback, true);
  if (issuerUrl.href !== issuer || !issuerUrl.pathname.endsWith('/dex')) throw new Error('Issuer must be an exact /dex URL');
  if (callbackUrl.href !== callback || callbackUrl.pathname !== '/api/human/auth/callback') {
    throw new Error('Callback must name the exact Khala auth route');
  }
  const clientSecret = required(env, 'KHALA_PREVIEW_OIDC_CLIENT_SECRET');
  if (clientSecret.length < 32) throw new Error('OIDC client secret is too short');
  const configDir = required(env, 'KHALA_PREVIEW_OIDC_CONFIG_DIR');
  if (!isAbsolute(configDir)) throw new Error('OIDC config directory must be absolute');
  const users = (['A', 'B'] as const).map(label => {
    const email = required(env, `KHALA_PREVIEW_OIDC_USER_${label}_EMAIL`);
    const hash = required(env, `KHALA_PREVIEW_OIDC_USER_${label}_BCRYPT_HASH`);
    const id = required(env, `KHALA_PREVIEW_OIDC_USER_${label}_ID`);
    const bcrypt = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(hash);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !bcrypt || Number(bcrypt[1]) < 10 || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error(`Invalid static OIDC user ${label}`);
    }
    return { email, hash, id };
  }) as [Inputs['users'][0], Inputs['users'][1]];
  if (users[0].email === users[1].email || users[0].id === users[1].id) throw new Error('OIDC users must be distinct');
  return { issuer, callback, clientId: required(env, 'KHALA_PREVIEW_OIDC_CLIENT_ID'), clientSecret, users, configDir };
}

export function renderDex(inputs: Inputs): string {
  const quoted = (value: string) => JSON.stringify(value);
  return [
    `issuer: ${quoted(inputs.issuer)}`,
    'storage:',
    '  type: memory', // Local only; hosted Dex requires durable storage.
    'web:',
    '  http: 0.0.0.0:5556',
    'oauth2:',
    '  responseTypes: [code]',
    '  grantTypes: [authorization_code]',
    '  skipApprovalScreen: true',
    'enablePasswordDB: true',
    'staticClients:',
    `  - id: ${quoted(inputs.clientId)}`,
    '    name: Khala disposable preview',
    `    secret: ${quoted(inputs.clientSecret)}`,
    '    redirectURIs:',
    `      - ${quoted(inputs.callback)}`,
    'staticPasswords:',
    ...inputs.users.flatMap((user, index) => [
      `  - email: ${quoted(user.email)}`,
      `    hash: ${quoted(user.hash)}`,
      `    username: ${quoted(`preview-${index + 1}`)}`,
      `    name: ${quoted(`Preview User ${index + 1}`)}`,
      '    emailVerified: true',
      `    userID: ${quoted(user.id)}`,
    ]),
    '',
  ].join('\n');
}

export async function writeDex(inputs: Inputs): Promise<string> {
  await mkdir(inputs.configDir, { recursive: true, mode: 0o700 });
  await chmod(inputs.configDir, 0o700);
  const target = resolve(inputs.configDir, 'dex.yaml');
  const temporary = resolve(inputs.configDir, `.dex.yaml.${process.pid}.tmp`);
  await writeFile(temporary, renderDex(inputs), { mode: 0o644, flag: 'wx' });
  await rename(temporary, target);
  await chmod(target, 0o644); // Docker bind mount must be readable by Dex UID 1001.
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await writeDex(readInputs(process.env));
    process.stdout.write('Dex config rendered in private directory\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'OIDC configuration failed'}\n`);
    process.exitCode = 1;
  }
}
