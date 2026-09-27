import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readInputs, renderDex, renderHostedDex, writeDex } from './render-dex.ts';

function environment(configDir: string): NodeJS.ProcessEnv {
  return {
    KHALA_PREVIEW_OIDC_ISSUER: 'http://127.0.0.1:15556/dex',
    KHALA_PREVIEW_OIDC_CALLBACK: 'http://127.0.0.1:15555/api/human/auth/callback',
    KHALA_PREVIEW_OIDC_CLIENT_ID: 'khala-local',
    KHALA_PREVIEW_OIDC_CLIENT_SECRET: 'a'.repeat(40),
    KHALA_PREVIEW_OIDC_CONFIG_DIR: configDir,
    KHALA_PREVIEW_OIDC_USER_A_EMAIL: 'a@preview.test',
    KHALA_PREVIEW_OIDC_USER_A_BCRYPT_HASH: '$2b$10$' + 'a'.repeat(53),
    KHALA_PREVIEW_OIDC_USER_A_ID: '11111111-1111-4111-8111-111111111111',
    KHALA_PREVIEW_OIDC_USER_B_EMAIL: 'b@preview.test',
    KHALA_PREVIEW_OIDC_USER_B_BCRYPT_HASH: '$2b$10$' + 'b'.repeat(53),
    KHALA_PREVIEW_OIDC_USER_B_ID: '22222222-2222-4222-8222-222222222222',
  };
}

test('renders two verified static users and an exact confidential callback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'khala-dex-test-'));
  const inputs = readInputs(environment(directory));
  const yaml = renderDex(inputs);
  assert.match(yaml, /emailVerified: true/g);
  assert.equal(yaml.match(/emailVerified: true/g)?.length, 2);
  assert.match(yaml, /grantTypes: \[authorization_code\]/);
  assert.match(yaml, /\/api\/human\/auth\/callback/);
  const target = await writeDex(inputs);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  assert.equal(await readFile(target, 'utf8'), yaml);
});

test('rejects an untrusted non-loopback HTTP issuer and duplicate users', () => {
  const env = environment('/tmp/khala-dex-test');
  env.KHALA_PREVIEW_OIDC_ISSUER = 'http://public.example/dex';
  assert.throws(() => readInputs(env), /HTTPS/);
  env.KHALA_PREVIEW_OIDC_ISSUER = 'http://127.0.0.1:15556/dex';
  env.KHALA_PREVIEW_OIDC_USER_B_EMAIL = env.KHALA_PREVIEW_OIDC_USER_A_EMAIL;
  assert.throws(() => readInputs(env), /distinct/);
  env.KHALA_PREVIEW_OIDC_USER_B_EMAIL = 'b@preview.test';
  env.KHALA_PREVIEW_OIDC_USER_B_BCRYPT_HASH = '$2b$05$' + 'b'.repeat(53);
  assert.throws(() => readInputs(env), /Invalid static OIDC user B/);
});

test('hosted Dex requires HTTPS and persists signing state in its own volume', () => {
  const env = environment('/tmp/khala-dex-hosted-test');
  assert.throws(() => renderHostedDex(env), /HTTPS/);
  env.KHALA_PREVIEW_OIDC_ISSUER = 'https://issuer.preview.test/dex';
  env.KHALA_PREVIEW_OIDC_CALLBACK = 'https://app.preview.test/api/human/auth/callback';
  const yaml = renderHostedDex(env);
  assert.match(yaml, /type: sqlite3\n  config:\n    file: \/data\/dex.db/);
  assert.match(yaml, /issuer: "https:\/\/issuer.preview.test\/dex"/);
  assert.match(yaml, /https:\/\/app.preview.test\/api\/human\/auth\/callback/);
  assert.doesNotMatch(yaml, /type: memory/);
});
