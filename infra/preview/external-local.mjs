#!/usr/bin/env node

// Disposable hosted-mode topology. All child output stays in private files;
// the terminal receives only stage names and a correlation ID.
import { spawn, execFile } from 'node:child_process';
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, realpathSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const compose = [path.join(root, 'infra/messaging/compose.yaml'), path.join(root, 'infra/preview/compose.yaml')];
const fixed = ['docker', 'netlify', 'pnpm', 'openssl', 'mkpasswd', 'unshare', 'socat'];
const secret = () => randomBytes(32).toString('hex');
const runId = randomBytes(6).toString('hex');
const project = `khala-${runId}-preview`;
const correlation = `external-${runId}`;
let stage = 'preflight';
const owned = [];
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());

export function assertExternalInputs(env) {
  if (env.KHALA_LOCAL_AUTH === 'enabled') throw new Error('local_auth_forbidden');
  for (const key of ['PUBLIC_APP_ORIGIN', 'PUBLIC_HOMESERVER_ORIGIN', 'OIDC_ISSUER']) {
    if (env[key] && !/^https:\/\/127\.0\.0\.1:\d+(?:\/dex)?$/u.test(env[key])) throw new Error(`${key}_must_be_loopback_https`);
  }
  if (env.KHALA_E2E_MATRIX_OBSERVER_TOKEN || env.KHALA_E2E_DISPOSABLE_ENV) throw new Error('fixture_credentials_forbidden');
}

async function command(bin, args, options = {}) {
  const { input, ...execOptions } = options;
  if (input === undefined) {
    return exec(bin, args, { cwd: root, maxBuffer: 128 * 1024, signal: abort.signal, ...execOptions });
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd: root, env: execOptions.env ?? process.env, signal: abort.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${bin}_failed_${code}`)));
    proc.stdin.end(input);
  });
}

async function availablePort() {
  const server = createHttpServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

function child(bin, args, env, outputFile, cwd = root) {
  const output = createWriteStream(outputFile, { flags: 'a', mode: 0o600 });
  const process = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  process.stdout.pipe(output, { end: false });
  process.stderr.pipe(output, { end: false });
  owned.push({ process, output });
  return process;
}

async function waitFor(check, process, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (abort.signal.aborted) throw new Error('interrupted');
    if (process && (process.exitCode !== null || process.signalCode !== null)) throw new Error(`child_exited_${process.exitCode ?? process.signalCode}`);
    try { if (await check()) return; } catch { /* service starting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('readiness_timeout');
}

async function hash(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }

async function secureGet(url, cert) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ca: cert, timeout: 5_000 }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts).toString('utf8') }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('request_timeout')));
    request.end();
  });
}

async function createCertificate(privateDir) {
  const key = path.join(privateDir, 'tls.key');
  const cert = path.join(privateDir, 'tls.crt');
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', `/CN=khala-${runId}.invalid`,
    '-addext', 'subjectAltName=IP:127.0.0.1']);
  await chmod(key, 0o600);
  // Chromium trusts only this key for this spawned smoke, without disabling
  // certificate checking for arbitrary origins.
  const pub = await command('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const spki = createPublicKey(pub.stdout).export({ format: 'der', type: 'spki' });
  return { key, cert, spki: createHash('sha256').update(spki).digest('base64') };
}

async function renderConfigs(env) {
  await command('node', ['infra/messaging/check.ts', '--environment', 'preview', '--render-only'], { env });
  await command('node', ['infra/preview/render-dex.ts'], { env });
}

async function composeCommand(args, env) {
  return command('docker', ['compose', '-p', project, '-f', compose[0], '-f', compose[1], ...args],
    { env, ...(args[0] === 'down' ? { signal: undefined } : {}) });
}

async function registerObserver(base, sharedSecret) {
  const nonceResponse = await fetch(`${base}/_synapse/admin/v1/register`);
  if (nonceResponse.status !== 200) throw new Error('observer_nonce_unavailable');
  const { nonce } = await nonceResponse.json();
  const username = `observer_${runId}`;
  const password = secret();
  const mac = createHmac('sha1', sharedSecret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest('hex');
  const registration = await fetch(`${base}/_synapse/admin/v1/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, username, password, admin: false, mac }),
  });
  if (registration.status !== 200) throw new Error('observer_registration_failed');
  const login = await fetch(`${base}/_matrix/client/v3/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: username }, password, device_id: `OBS_${runId}` }),
  });
  if (login.status !== 200) throw new Error('observer_login_failed');
  const result = await login.json();
  return { userId: result.user_id, token: result.access_token };
}

function startGateway(originPort, tls, targets) {
  const server = createHttpsServer(tls, (request, response) => {
    const url = request.url ?? '/';
    const dex = url === '/dex' || url.startsWith('/dex/');
    const matrix = url.startsWith('/_matrix/') || url.startsWith('/_synapse/') || url === '/health';
    const upstream = dex ? { host: '127.0.0.1', port: targets.dex } : matrix
      ? { host: '127.0.0.1', port: targets.synapse }
      : { socketPath: targets.netlifySocket };
    const headers = { ...request.headers, host: `127.0.0.1:${originPort}`,
      'x-forwarded-host': `127.0.0.1:${originPort}`, 'x-forwarded-proto': 'https' };
    const requestOptions = { ...upstream, method: request.method, path: url, headers };
    const proxy = matrix || dex
      ? createHttpRequest(requestOptions, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      })
      : httpsRequest({ ...requestOptions, host: '127.0.0.1', ca: tls.cert }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    proxy.on('error', () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
    request.pipe(proxy);
  });
  return server;
}

import { request as createHttpRequest } from 'node:http';

async function main() {
  assertExternalInputs(process.env);
  const execAt = process.argv.indexOf('--exec');
  const extraCommand = execAt === -1 ? null : process.argv.slice(execAt + 1);
  if (execAt !== -1 && (extraCommand.length === 0 || process.argv.slice(2, execAt).length !== 0)) throw new Error('invalid_exec_arguments');
  const scratch = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-external-'));
  await chmod(scratch, 0o700);
  const log = path.join(scratch, 'children.log');
  const matrixDir = path.join(scratch, 'matrix');
  const dexDir = path.join(scratch, 'dex');
  const gatewayPort = await availablePort();
  const dexPort = await availablePort();
  const netlifyPort = await availablePort();
  const origin = `https://127.0.0.1:${gatewayPort}`;
  const passwordA = secret();
  const passwordB = secret();
  const bcrypt = async value => {
    const result = await command('mkpasswd', ['-m', 'bcrypt', '-R', '10', '-s'], { input: value });
    return result.stdout.trim();
  };
  const env = { ...process.env,
    KHALA_ENVIRONMENT: 'preview', KHALA_STATE_NAMESPACE: project,
    KHALA_MATRIX_SERVER_NAME: `${runId}.matrix.invalid`, KHALA_MATRIX_PUBLIC_ORIGIN: origin,
    KHALA_MATRIX_REGISTRATION_SHARED_SECRET: secret(), KHALA_DB_HOST: 'postgres', KHALA_DB_PORT: '5432',
    KHALA_DB_NAME: 'synapse', KHALA_DB_USER: 'synapse', KHALA_DB_PASSWORD: secret(), KHALA_CONFIG_DIR: matrixDir,
    KHALA_PREVIEW_OIDC_ISSUER: `${origin}/dex`, KHALA_PREVIEW_OIDC_CALLBACK: `${origin}/api/human/auth/callback`,
    KHALA_PREVIEW_OIDC_CLIENT_ID: `khala-${runId}`, KHALA_PREVIEW_OIDC_CLIENT_SECRET: secret(),
    KHALA_PREVIEW_OIDC_CONFIG_DIR: dexDir, KHALA_PREVIEW_DEX_PORT: String(dexPort),
    KHALA_PREVIEW_OIDC_USER_A_EMAIL: `a-${runId}@example.invalid`, KHALA_PREVIEW_OIDC_USER_A_BCRYPT_HASH: await bcrypt(passwordA),
    KHALA_PREVIEW_OIDC_USER_A_ID: randomUUID(), KHALA_PREVIEW_OIDC_USER_B_EMAIL: `b-${runId}@example.invalid`,
    KHALA_PREVIEW_OIDC_USER_B_BCRYPT_HASH: await bcrypt(passwordB), KHALA_PREVIEW_OIDC_USER_B_ID: randomUUID(),
    PUBLIC_APP_ORIGIN: origin, PUBLIC_HOMESERVER_ORIGIN: origin, OIDC_ISSUER: `${origin}/dex`,
    OIDC_CLIENT_ID: `khala-${runId}`, CONTROL_STATE_NAMESPACE: `external-${runId}`,
    MATRIX_SERVER_NAME: `${runId}.matrix.invalid`, MATRIX_PASSWORD_DERIVATION_SECRET: secret(), INVITATION_HMAC_SECRET: secret(),
    XDG_CONFIG_HOME: path.join(scratch, 'xdg'), NETLIFY_HOME: path.join(scratch, 'netlify-home'),
  };
  env.OIDC_CLIENT_SECRET = env.KHALA_PREVIEW_OIDC_CLIENT_SECRET;
  env.MATRIX_REGISTRATION_SHARED_SECRET = env.KHALA_MATRIX_REGISTRATION_SHARED_SECRET;
  delete env.KHALA_LOCAL_AUTH;
  let stackStarted = false;
  let gateway;
  try {
    stage = 'native-clis';
    for (const bin of fixed) await command('sh', ['-c', `command -v ${bin} >/dev/null`]);
    stage = 'render-config';
    await renderConfigs(env);
    stage = 'compose';
    await composeCommand(['config', '--quiet'], env);
    stackStarted = true;
    await composeCommand(['up', '-d', '--wait'], env);
    const mapped = await composeCommand(['port', 'synapse', '8008'], env);
    const synapsePort = Number(mapped.stdout.trim().split(':').at(-1));
    if (!Number.isInteger(synapsePort)) throw new Error('synapse_port_missing');
    stage = 'matrix-boundary';
    const checkEnv = { ...env, KHALA_MATRIX_CHECK_ORIGIN: `http://127.0.0.1:${synapsePort}`, KHALA_ALLOW_INSECURE_LOOPBACK: 'true' };
    await command('node', ['infra/messaging/check.ts', '--environment', 'preview'], { env: checkEnv });
    const observer = await registerObserver(checkEnv.KHALA_MATRIX_CHECK_ORIGIN, env.KHALA_MATRIX_REGISTRATION_SHARED_SECRET);
    stage = 'build-artifacts';
    await command('pnpm', ['--filter', '@khala/control', 'build:functions'], { env });
    await command('pnpm', ['--filter', '@khala/web', 'build'], { env });
    await command('pnpm', ['--filter', '@aiur/khala', 'build'], { env });
    const tls = await createCertificate(scratch);
    env.NODE_EXTRA_CA_CERTS = tls.cert;
    const trustedCert = await readFile(tls.cert);
    const sourceConfig = await readFile(path.join(root, 'netlify.toml'), 'utf8');
    await writeFile(path.join(scratch, 'netlify.toml'), `${sourceConfig}\n[dev.https]\n  keyFile = ${JSON.stringify(tls.key)}\n  certFile = ${JSON.stringify(tls.cert)}\n`, { mode: 0o600 });
    const socket = path.join(scratch, 'netlify.sock');
    const tlsSocket = path.join(scratch, 'tls.sock');
    stage = 'network-bridge';
    child('socat', [`UNIX-LISTEN:${tlsSocket},fork,mode=0600`, `TCP:127.0.0.1:${gatewayPort}`], env, log);
    const netlifyExecutable = (await command('sh', ['-c', 'command -v netlify'])).stdout.trim();
    const netlifyPackage = path.resolve(path.dirname(realpathSync(netlifyExecutable)), '..');
    const bundledBlobs = path.join(netlifyPackage, 'node_modules/@netlify/blobs');
    const bundledVersion = JSON.parse(await readFile(path.join(bundledBlobs, 'package.json'), 'utf8')).version;
    if (bundledVersion !== '10.7.13') throw new Error('unsupported_netlify_blobs_adapter');
    const namespaceEnv = { ...env,
      KHALA_LOCAL_NETLIFY_BLOBS_SERVER: path.join(bundledBlobs, 'dist/server.js'),
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${path.join(root, 'infra/preview/netlify-blobs-etag.mjs')}`.trim(),
    };
    const namespaceArgs = ['-Urn', 'sh', '-c',
      `ip link set lo up; socat TCP-LISTEN:${gatewayPort},bind=127.0.0.1,fork UNIX-CONNECT:${tlsSocket} & ` +
      `socat UNIX-LISTEN:${socket},fork,mode=0600 TCP:127.0.0.1:${netlifyPort} & ` +
      `exec netlify dev --offline --no-open --dir '${root}/apps/web/dist' ` +
      `--functions '${root}/infra/netlify/functions-generated' --port ${netlifyPort}`];
    let namespace = child('unshare', namespaceArgs, namespaceEnv, log, scratch);
    await waitFor(async () => { const stat = await import('node:fs/promises').then(fs => fs.stat(socket)); return stat.isSocket(); }, namespace);
    gateway = startGateway(gatewayPort, { key: await readFile(tls.key), cert: trustedCert },
      { dex: dexPort, synapse: synapsePort, netlifySocket: socket });
    await new Promise((resolve, reject) => gateway.once('error', reject).listen(gatewayPort, '127.0.0.1', resolve));
    stage = 'netlify-routing';
    await waitFor(async () => (await secureGet(`${origin}/api/health`, trustedCert)).status === 200, namespace);
    const direct = await secureGet(`${origin}/.netlify/functions/khala-control/health`, trustedCert);
    if (direct.status !== 200) throw new Error('direct_function_route_failed');
    stage = 'oidc-discovery';
    const discovery = await secureGet(`${origin}/dex/.well-known/openid-configuration`, trustedCert);
    if (discovery.status !== 200 || JSON.parse(discovery.body).issuer !== `${origin}/dex`) throw new Error('oidc_discovery_failed');
    const descriptor = { environmentId: runId, appOrigin: origin, homeserverOrigin: origin, synapseVersion: '1.161.0',
      oauth: { usernameLabel: 'Email', usernamePlaceholder: 'email address', passwordLabel: 'Password', submitName: 'Login' },
      users: [{ usernameEnv: 'KHALA_E2E_USER_A', passwordEnv: 'KHALA_E2E_USER_A_PASSWORD' },
        { usernameEnv: 'KHALA_E2E_USER_B', passwordEnv: 'KHALA_E2E_USER_B_PASSWORD' }],
      observer: { userId: observer.userId, accessTokenEnv: 'KHALA_E2E_MATRIX_OBSERVER_TOKEN' } };
    const descriptorPath = path.join(scratch, 'descriptor.json');
    await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
    stage = 'browser-smoke';
    const smokeEnv = { ...env, KHALA_E2E_LIVE: '1', KHALA_E2E_DISPOSABLE_ENV: descriptorPath,
      KHALA_E2E_USER_A: env.KHALA_PREVIEW_OIDC_USER_A_EMAIL, KHALA_E2E_USER_A_PASSWORD: passwordA,
      KHALA_E2E_USER_B: env.KHALA_PREVIEW_OIDC_USER_B_EMAIL, KHALA_E2E_USER_B_PASSWORD: passwordB,
      KHALA_E2E_MATRIX_OBSERVER_TOKEN: observer.token, KHALA_E2E_CERT_SPKI: tls.spki,
      KHALA_APP_ORIGIN: origin, XDG_STATE_HOME: path.join(scratch, 'state') };
    await command('pnpm', ['test:integration', 'tests/integration/human/create-share-chat.spec.ts',
      '--output', path.join(scratch, 'playwright-results')], { env: smokeEnv, timeout: 300_000 });
    stage = 'blobs-restart-write';
    const browserState = path.join(scratch, 'browser-state.json');
    await command('node', ['--import', 'tsx', 'infra/preview/session-restart-smoke.ts', 'before', browserState], { env: smokeEnv, timeout: 60_000 });
    stage = 'function-restart';
    if (namespace.pid && namespace.exitCode === null) {
      try { process.kill(-namespace.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; namespace.kill('SIGTERM'); }
    }
    if (namespace.exitCode === null && namespace.signalCode === null) {
      await new Promise(resolve => namespace.once('exit', resolve));
    }
    await unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
    namespace = child('unshare', namespaceArgs, namespaceEnv, log, scratch);
    await waitFor(async () => { const stat = await import('node:fs/promises').then(fs => fs.stat(socket)); return stat.isSocket(); }, namespace);
    await waitFor(async () => (await secureGet(`${origin}/api/health`, trustedCert)).status === 200, namespace);
    stage = 'blobs-restart-read';
    await command('node', ['--import', 'tsx', 'infra/preview/session-restart-smoke.ts', 'after', browserState], { env: smokeEnv, timeout: 60_000 });
    stage = 'installed-connector';
    const packageDirectory = path.join(root, 'packages/agent-cli');
    const packed = await command('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], { cwd: packageDirectory, env: smokeEnv });
    const tarball = path.join(scratch, packed.stdout.trim().split('\n').at(-1));
    const prefix = path.join(scratch, 'installed');
    await command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball],
      { env: { ...smokeEnv, npm_config_cache: path.join(scratch, 'npm-cache') } });
    const installedCli = path.join(prefix, 'node_modules/@aiur/khala/dist/khala.js');
    const connectorEnv = { ...smokeEnv };
    delete connectorEnv.CODEX_THREAD_ID;
    delete connectorEnv.CLAUDE_SESSION_ID;
    const installedStatus = await command('node', [installedCli, 'status'], { env: connectorEnv });
    if (typeof JSON.parse(installedStatus.stdout) !== 'object') throw new Error('installed_status_invalid');
    const open = await command('node', [installedCli, 'channels', 'open'], { env: connectorEnv });
    if (!open.stdout.includes(`${origin}/new`)) throw new Error('installed_origin_mismatch');
    if (extraCommand) {
      stage = 'external-consumer';
      await command(extraCommand[0], extraCommand.slice(1), { env: { ...smokeEnv, KHALA_EXTERNAL_CLI: installedCli,
        KHALA_EXTERNAL_ORIGIN: origin }, timeout: 300_000 });
    }
    stage = 'report';
    const source = await command('git', ['rev-parse', 'HEAD']);
    const versions = await Promise.all([command('docker', ['version', '--format', '{{.Server.Version}}']), command('netlify', ['--version'], { env })]);
    process.stdout.write(JSON.stringify({ correlation, result: 'passed', sourceCommit: source.stdout.trim(),
      lockfileSha256: await hash(path.join(root, 'pnpm-lock.yaml')),
      artifacts: { functionSha256: await hash(path.join(root, 'infra/netlify/functions-generated/khala-control.mjs')),
        webSha256: await hash(path.join(root, 'apps/web/dist/index.html')),
        connectorSha256: await hash(path.join(root, 'packages/agent-cli/dist/khala.js')) },
      scopes: { project, control: env.CONTROL_STATE_NAMESPACE, origin },
      versions: { docker: versions[0].stdout.trim(), netlify: versions[1].stdout.trim(), synapse: '1.161.0', dex: '2.43.1' } }) + '\n');
  } finally {
    if (gateway) await new Promise(resolve => gateway.close(resolve));
    for (const { process: proc, output } of owned.reverse()) {
      if (proc.pid && proc.exitCode === null) { try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already exited */ } }
      output.end();
    }
    if (stackStarted) await composeCommand(['down', '--volumes'], env).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(JSON.stringify({ correlation, result: 'failed', stage,
    code: /^(?:child_exited_[\w-]+|readiness_timeout|[a-z_]+_failed_\d+)$/u.test(error?.message) ? error.message
      : ['ESRCH', 'ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'stage_failed' }) + '\n'); process.exitCode = 1; });
}
