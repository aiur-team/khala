#!/usr/bin/env node
// Persistent, loopback-only local external stack.
import { spawn, execFile } from 'node:child_process';
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { openSync, closeSync, realpathSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const localDir = path.join(root, '.khala-local');
const project = 'khala-local-preview';
const services = ['synapse', 'postgres', 'dex', 'netlify', 'gateway'];
const secret = () => randomBytes(32).toString('hex');
const compose = [path.join(root, 'infra/messaging/compose.yaml'), path.join(root, 'infra/local/compose.dex.yaml')];
const composeArgs = ['compose', '-p', project, '-f', compose[0], '-f', compose[1]];
async function command(bin, args, options = {}) {
  const { input, ...execOptions } = options;
  if (input === undefined) {
    return exec(bin, args, { cwd: root, maxBuffer: 128 * 1024, ...execOptions });
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd: root, env: execOptions.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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

async function waitFor(check, process, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (process && (process.exitCode !== null || process.signalCode !== null)) throw new Error(`child_exited_${process.exitCode ?? process.signalCode}`);
    try { if (await check()) return; } catch { /* service starting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('readiness_timeout');
}

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
  if (!(await exists(cert))) await command('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '825',
    '-keyout', key, '-out', cert, '-subj', '/CN=khala-local.invalid',
    '-addext', 'subjectAltName=IP:127.0.0.1']);
  await chmod(key, 0o600);
  // Chromium trusts only this key for this spawned smoke, without disabling
  // certificate checking for arbitrary origins.
  const pub = await command('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const spki = createPublicKey(pub.stdout).export({ format: 'der', type: 'spki' });
  return { key, cert, spki: createHash('sha256').update(spki).digest('base64') };
}

async function composeCommand(args, env) {
  return command('docker', [...composeArgs, ...args],
    { env });
}

async function registerObserver(base, sharedSecret, password, fetchRequest = fetch) {
  const username = 'observer';
  const login = () => fetchRequest(`${base}/_matrix/client/v3/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: username }, password, device_id: 'OBS_LOCAL' }),
  });
  let response = await login();
  if (response.status === 200) {
    const result = await response.json();
    return { userId: result.user_id, accessToken: result.access_token };
  }
  if (response.status !== 403) throw new Error('observer_login_failed');
  const nonceResponse = await fetchRequest(`${base}/_synapse/admin/v1/register`);
  if (nonceResponse.status !== 200) throw new Error('observer_nonce_unavailable');
  const { nonce } = await nonceResponse.json();
  const mac = createHmac('sha1', sharedSecret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest('hex');
  const registration = await fetchRequest(`${base}/_synapse/admin/v1/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, username, password, admin: false, mac }),
  });
  if (registration.status !== 200) throw new Error('observer_registration_failed');
  response = await login();
  if (response.status !== 200) throw new Error('observer_login_failed');
  const result = await response.json();
  return { userId: result.user_id, accessToken: result.access_token };
}

export async function ensureObserver(base, state, dir, deps = {}) {
  if (state.observer) return state.observer;
  if (!state.observerPassword) {
    state.observerPassword = (deps.randomHex ?? secret)();
    await saveState(dir, state);
  }
  state.observer = await registerObserver(base, state.secrets.registrationSharedSecret, state.observerPassword, deps.fetch ?? fetch);
  await saveState(dir, state);
  return state.observer;
}

function startGateway(originPort, tls, targets) {
  const server = createHttpsServer(tls, (request, response) => {
    const url = request.url ?? '/';
    const dex = url === '/dex' || url.startsWith('/dex/');
    const matrix = url.startsWith('/_matrix/') || url.startsWith('/_synapse/') || url === '/health';
    const upstream = dex ? { host: '127.0.0.1', port: targets.dex } : matrix
      ? { host: '127.0.0.1', port: targets.synapse }
      : { host: '127.0.0.1', port: targets.netlify };
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


export function parseArgs(argv) {
  const [command, ...args] = argv[0] === '--' ? argv.slice(1) : argv;
  if (!['up', 'down', 'logs', 'status', '__gateway'].includes(command)) throw new Error(`unknown_command:${command}`);
  if (command === 'down' && args.length === 1 && args[0] === '--wipe') return { command, wipe: true };
  if (command === 'logs' && args.length === 1 && services.includes(args[0])) return { command, wipe: false, service: args[0] };
  if (args.length) throw new Error(`invalid_arguments:${command}`);
  return { command, wipe: false };
}

async function exists(file) {
  try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readState(dir) {
  try { return JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function saveState(dir, state) {
  const temporary = path.join(dir, `.state.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path.join(dir, 'state.json'));
}

export async function assertPortFree(port, service) {
  const server = createHttpServer();
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  } catch (error) { throw new Error(`port_unavailable:${service}:${port}`, { cause: error }); }
  await new Promise(resolve => server.close(resolve));
}

export async function loadOrCreateState(dir, deps = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const previous = await readState(dir);
  if (previous) { await chmod(path.join(dir, 'state.json'), 0o600); return previous; }
  const randomHex = deps.randomHex ?? secret;
  const freePort = deps.availablePort ?? availablePort;
  const bcrypt = deps.bcrypt ?? (async password => (await command('mkpasswd', ['-m', 'bcrypt', '-R', '10', '-s'], { input: password })).stdout.trim());
  let gateway = 8443;
  try { await (deps.assertPortFree ?? assertPortFree)(gateway, 'gateway'); } catch { gateway = await freePort(); }
  const ports = { gateway };
  for (const name of ['dex', 'netlify', 'functions']) {
    let port;
    do { port = await freePort(); } while (Object.values(ports).includes(port));
    ports[name] = port;
  }
  const secrets = Object.fromEntries(['dbPassword', 'registrationSharedSecret', 'oidcClientSecret', 'passwordDerivationSecret', 'invitationHmacSecret'].map(key => [key, randomHex()]));
  const users = [];
  for (const name of ['alice', 'bob']) {
    const password = randomHex();
    users.push({ email: `${name}@khala.local`, password, bcrypt: await bcrypt(password), id: randomUUID() });
  }
  const state = { version: 1, project, serverName: 'khala.local', ports, secrets, users, pids: {} };
  await saveState(dir, state);
  return state;
}

export function buildEnv(state, dir, inherited = process.env) {
  const origin = `https://127.0.0.1:${state.ports.gateway}`;
  const home = path.join(dir, 'home');
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'CI', 'PLAYWRIGHT_BROWSERS_PATH']
    .filter(key => inherited[key] !== undefined).map(key => [key, inherited[key]]));
  Object.assign(env, {
    HOME: home, TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'), NETLIFY_HOME: path.join(home, 'netlify'), CODEX_HOME: path.join(home, 'codex'),
    NODE_EXTRA_CA_CERTS: path.join(dir, 'certs/tls.crt'),
    KHALA_ENVIRONMENT: 'preview', KHALA_STATE_NAMESPACE: project,
    KHALA_MATRIX_SERVER_NAME: state.serverName, MATRIX_SERVER_NAME: state.serverName,
    KHALA_MATRIX_PUBLIC_ORIGIN: origin, KHALA_MATRIX_REGISTRATION_SHARED_SECRET: state.secrets.registrationSharedSecret,
    MATRIX_REGISTRATION_SHARED_SECRET: state.secrets.registrationSharedSecret,
    KHALA_DB_HOST: 'postgres', KHALA_DB_PORT: '5432', KHALA_DB_NAME: 'synapse', KHALA_DB_USER: 'synapse',
    KHALA_DB_PASSWORD: state.secrets.dbPassword, KHALA_CONFIG_DIR: path.join(dir, 'matrix'),
    KHALA_PREVIEW_OIDC_ISSUER: `${origin}/dex`, KHALA_PREVIEW_OIDC_CALLBACK: `${origin}/api/human/auth/callback`,
    KHALA_PREVIEW_OIDC_CLIENT_ID: 'khala-local', KHALA_PREVIEW_OIDC_CLIENT_SECRET: state.secrets.oidcClientSecret,
    KHALA_PREVIEW_OIDC_CONFIG_DIR: path.join(dir, 'dex'), KHALA_PREVIEW_DEX_PORT: String(state.ports.dex),
    PUBLIC_APP_ORIGIN: origin, PUBLIC_HOMESERVER_ORIGIN: origin, OIDC_ISSUER: `${origin}/dex`, OIDC_CLIENT_ID: 'khala-local',
    OIDC_CLIENT_SECRET: state.secrets.oidcClientSecret, CONTROL_STATE_NAMESPACE: 'khala-local',
    MATRIX_PASSWORD_DERIVATION_SECRET: state.secrets.passwordDerivationSecret, INVITATION_HMAC_SECRET: state.secrets.invitationHmacSecret,
    KHALA_ADMISSION_MODE: 'explicit_browser_consent', KHALA_LOCAL_EXTERNAL_DIAGNOSTICS: '1',
  });
  for (const [index, label] of ['A', 'B'].entries()) {
    env[`KHALA_PREVIEW_OIDC_USER_${label}_EMAIL`] = state.users[index].email;
    env[`KHALA_PREVIEW_OIDC_USER_${label}_BCRYPT_HASH`] = state.users[index].bcrypt;
    env[`KHALA_PREVIEW_OIDC_USER_${label}_ID`] = state.users[index].id;
  }
  return env;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    // Container init may leave exited children waiting to be reaped.
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) { return error.code === 'EPERM'; }
}

function processIdentity(pid) {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return undefined; }
}

function serviceAlive(state, service) {
  const pid = state.pids[service];
  if (!pidAlive(pid)) return false;
  if (process.platform !== 'linux') return true;
  if (state.pidStarts?.[service]) return processIdentity(pid) === state.pidStarts[service];
  // Older state has no process identity; refuse to kill a reused unrelated PID.
  try {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return service === 'gateway'
      ? commandLine.includes(path.join(root, 'infra/local/stack.mjs')) && commandLine.includes('__gateway')
      : commandLine.includes('netlify') && commandLine.includes('dev');
  } catch { return false; }
}

async function httpGet(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  return response.status;
}

function parseComposeStatus(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  return trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').map(line => JSON.parse(line));
}

export async function collectStatus(state, probes) {
  const origin = `https://127.0.0.1:${state?.ports.gateway ?? 8443}`;
  const result = { origin, homeserver: origin, dex: `${origin}/dex`,
    users: (state?.users ?? []).map(({ email, password }) => ({ email, password })),
    services: Object.fromEntries(services.map(service => [service, 'down'])) };
  if (!state) return result;
  if (!probes) {
    const env = buildEnv(state, localDir);
    let containers = [];
    try { containers = parseComposeStatus((await composeCommand(['ps', '--format', 'json'], env)).stdout); } catch { /* Docker down */ }
    const tlsGet = async url => secureGet(url, await readFile(path.join(localDir, 'certs/tls.crt')));
    probes = {
      postgres: async () => containers.some(row => row.Service === 'postgres' && row.State === 'running'),
      synapse: async () => containers.some(row => row.Service === 'synapse' && row.State === 'running'),
      dex: async () => await httpGet(`http://127.0.0.1:${state.ports.dex}/dex/.well-known/openid-configuration`) === 200,
      netlify: async () => serviceAlive(state, 'netlify') && (await tlsGet(`https://127.0.0.1:${state.ports.netlify}/api/health`)).status === 200,
      gateway: async () => serviceAlive(state, 'gateway') && Boolean((await tlsGet(`${origin}/_matrix/client/versions`)).status),
    };
  }
  await Promise.all(services.map(async service => {
    try { if (await probes[service]()) result.services[service] = 'up'; } catch { /* failed probe is down */ }
  }));
  return result;
}

export async function detachedChild(bin, args, env, logFile, cwd = root) {
  const fd = openSync(logFile, 'a', 0o600);
  let child;
  try { child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}

async function stopGroup(pid) {
  if (!pidAlive(pid)) return;
  try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const until = Date.now() + 10000;
  while (pidAlive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  if (pidAlive(pid)) throw new Error(`process_stop_timeout:${pid}`);
}

async function tail(file, lines) {
  try { return (await readFile(file, 'utf8')).trimEnd().split('\n').slice(-lines).join('\n') + '\n'; }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function loggedCommand(service, bin, args, options = {}) {
  const file = path.join(localDir, 'logs', `${service}.log`);
  try {
    const result = await command(bin, args, options);
    await writeFile(file, result.stdout + result.stderr, { flag: 'a', mode: 0o600 });
    return result;
  } catch (error) {
    await writeFile(file, (error.stdout ?? '') + (error.stderr ?? '') + error.message + '\n', { flag: 'a', mode: 0o600 });
    error.service = service;
    throw error;
  }
}

async function reportFailure(error, service, state) {
  const logFile = path.join(localDir, 'logs', `${error.service ?? service}.log`);
  if (state && ['postgres', 'synapse', 'dex'].includes(service)) {
    try {
      const result = await composeCommand(['logs', '--tail', '40', service], buildEnv(state, localDir));
      await writeFile(logFile, result.stdout + result.stderr, { flag: 'a', mode: 0o600 });
    } catch { /* retain original error */ }
  }
  process.stderr.write(`${error.message}\nLog: ${logFile}\n${await tail(logFile, 40)}`);
}

async function writeFixtures(state) {
  const origin = `https://127.0.0.1:${state.ports.gateway}`;
  const descriptor = { environmentId: 'khala-local', appOrigin: origin, homeserverOrigin: origin, synapseVersion: '1.161.0',
    oauth: { usernameLabel: 'Email', usernamePlaceholder: 'email address', passwordLabel: 'Password', submitName: 'Login' },
    users: [{ usernameEnv: 'KHALA_E2E_USER_A', passwordEnv: 'KHALA_E2E_USER_A_PASSWORD' },
      { usernameEnv: 'KHALA_E2E_USER_B', passwordEnv: 'KHALA_E2E_USER_B_PASSWORD' }],
    observer: { userId: state.observer.userId, accessTokenEnv: 'KHALA_E2E_MATRIX_OBSERVER_TOKEN' } };
  await writeFile(path.join(localDir, 'descriptor.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
  const env = { KHALA_E2E_LIVE: '1', KHALA_E2E_DISPOSABLE_ENV: path.join(localDir, 'descriptor.json'),
    KHALA_E2E_USER_A: state.users[0].email, KHALA_E2E_USER_A_PASSWORD: state.users[0].password,
    KHALA_E2E_USER_B: state.users[1].email, KHALA_E2E_USER_B_PASSWORD: state.users[1].password,
    KHALA_E2E_MATRIX_OBSERVER_TOKEN: state.observer.accessToken, KHALA_E2E_CERT_SPKI: state.spki,
    NODE_EXTRA_CA_CERTS: path.join(localDir, 'certs/tls.crt'), KHALA_APP_ORIGIN: origin };
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(path.join(localDir, 'e2e.env'), Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n') + '\n', { mode: 0o600 });
  await chmod(path.join(localDir, 'e2e.env'), 0o600);
}

export async function netlifyBase(checkoutRoot) {
  let candidate = checkoutRoot;
  while (true) {
    try {
      if ((await stat(path.join(candidate, '.git'))).isDirectory()) break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(candidate);
    if (parent === candidate) { candidate = checkoutRoot; break; }
    candidate = parent;
  }
  return path.relative(candidate, path.join(checkoutRoot, '.khala-local/netlify'));
}

async function up() {
  let state;
  let service = 'netlify';
  for (const bin of ['docker', 'netlify', 'pnpm', 'openssl', 'mkpasswd']) {
    try { await command('sh', ['-c', `command -v ${bin} >/dev/null`]); }
    catch { throw new Error(`missing_binary:${bin}`); }
  }
  if (!(await readState(localDir)) && (await command('docker', ['volume', 'ls', '-q', '--filter', `name=${project}_`])).stdout.trim()) {
    throw new Error('state_missing_but_volumes_exist: run pnpm stack:down --wipe');
  }
  state = await loadOrCreateState(localDir);
  const env = buildEnv(state, localDir);
  for (const directory of ['logs', 'certs', 'netlify', ...['', 'tmp', 'config', 'data', 'state', 'cache', 'netlify', 'codex'].map(name => path.join('home', name))]) {
    await mkdir(path.join(localDir, directory), { recursive: true, mode: 0o700 });
  }
  try {
    const tls = await createCertificate(path.join(localDir, 'certs'));
    state.spki = tls.spki;
    await saveState(localDir, state);
    service = 'synapse';
    await loggedCommand(service, 'node', ['infra/messaging/check.ts', '--environment', 'preview', '--render-only'], { env });
    service = 'dex';
    await loggedCommand(service, 'node', ['infra/local/render-dex.ts'], { env });
    service = 'synapse';
    await loggedCommand(service, 'docker', [...composeArgs, 'config', '--quiet'], { env });
    await loggedCommand(service, 'docker', [...composeArgs, 'up', '-d', '--wait'], { env, timeout: 180000 });
    state.synapsePort = Number((await composeCommand(['port', 'synapse', '8008'], env)).stdout.trim().split(':').at(-1));
    if (!state.synapsePort) throw new Error('synapse_port_missing');
    await saveState(localDir, state);
    const checkEnv = { ...env, KHALA_MATRIX_CHECK_ORIGIN: `http://127.0.0.1:${state.synapsePort}`, KHALA_ALLOW_INSECURE_LOOPBACK: 'true' };
    await loggedCommand(service, 'node', ['infra/messaging/check.ts', '--environment', 'preview'], { env: checkEnv });
    await ensureObserver(checkEnv.KHALA_MATRIX_CHECK_ORIGIN, state, localDir);
    const cert = await readFile(tls.cert);
    const status = await collectStatus(state);
    service = 'netlify';
    if (status.services.netlify === 'down') {
      if (serviceAlive(state, 'netlify')) await stopGroup(state.pids.netlify);
      await assertPortFree(state.ports.netlify, service);
      const help = await command('netlify', ['dev', '--help'], { env });
      if (!help.stdout.includes('--functions-port')) { delete state.ports.functions; await saveState(localDir, state); }
      if (state.ports.functions) await assertPortFree(state.ports.functions, 'functions');
      await loggedCommand(service, 'pnpm', ['--filter', '@khala/control', 'build:functions'], { env, maxBuffer: 4 * 1024 * 1024 });
      await loggedCommand(service, 'pnpm', ['--filter', '@khala/web', 'build'], { env, maxBuffer: 4 * 1024 * 1024 });
      // Keep Netlify's config re-resolution in the persistent directory.
      const config = (await readFile(path.join(root, 'netlify.toml'), 'utf8')).replace('base = "."', `base = ${JSON.stringify(await netlifyBase(root))}`);
      await writeFile(path.join(localDir, 'netlify/netlify.toml'), `${config}\n[dev.https]\n  keyFile = ${JSON.stringify(tls.key)}\n  certFile = ${JSON.stringify(tls.cert)}\n`, { mode: 0o600 });
      const executable = (await command('sh', ['-c', 'command -v netlify'])).stdout.trim();
      const bundledBlobs = path.join(path.resolve(path.dirname(realpathSync(executable)), '..'), 'node_modules/@netlify/blobs');
      const version = JSON.parse(await readFile(path.join(bundledBlobs, 'package.json'), 'utf8')).version;
      if (version !== '10.7.13') throw new Error(`unsupported_netlify_blobs_adapter:${version}`);
      const netlifyEnv = { ...env, KHALA_LOCAL_NETLIFY_BLOBS_SERVER: path.join(bundledBlobs, 'dist/server.js'),
        NODE_OPTIONS: `--import=${path.join(root, 'infra/local/netlify-blobs-etag.mjs')}` };
      const args = ['dev', '--offline', '--no-open', '--skip-gitignore', '--dir', path.join(root, 'apps/web/dist'),
        '--functions', path.join(root, 'infra/netlify/functions-generated'), '--port', String(state.ports.netlify)];
      if (state.ports.functions) args.push('--functions-port', String(state.ports.functions));
      const child = await detachedChild('netlify', args, netlifyEnv, path.join(localDir, 'logs/netlify.log'), path.join(localDir, 'netlify'));
      state.pids.netlify = child.pid;
      state.pidStarts ??= {};
      state.pidStarts.netlify = processIdentity(child.pid);
      await saveState(localDir, state);
      await waitFor(async () => (await secureGet(`https://127.0.0.1:${state.ports.netlify}/api/health`, cert)).status === 200, child);
    }
    service = 'gateway';
    if (status.services.gateway === 'down' || state.gatewaySynapsePort !== state.synapsePort) {
      if (serviceAlive(state, 'gateway')) await stopGroup(state.pids.gateway);
      await assertPortFree(state.ports.gateway, service);
      const child = await detachedChild(process.execPath, [path.join(root, 'infra/local/stack.mjs'), '__gateway'], env, path.join(localDir, 'logs/gateway.log'));
      state.pids.gateway = child.pid;
      state.pidStarts ??= {};
      state.pidStarts.gateway = processIdentity(child.pid);
      state.gatewaySynapsePort = state.synapsePort;
      await saveState(localDir, state);
      await waitFor(async () => (await secureGet(env.PUBLIC_APP_ORIGIN + '/api/health', cert)).status === 200, child);
    }
    service = 'dex';
    const discovery = await secureGet(`${env.PUBLIC_APP_ORIGIN}/dex/.well-known/openid-configuration`, cert);
    if (discovery.status !== 200 || JSON.parse(discovery.body).issuer !== `${env.PUBLIC_APP_ORIGIN}/dex`) throw new Error('oidc_discovery_failed');
    await writeFixtures(state);
    await saveState(localDir, state);
    process.stdout.write(JSON.stringify(await collectStatus(state)) + '\n');
    for (const user of state.users) process.stderr.write(`${user.email}: ${user.password}\n`);
  } catch (error) {
    await reportFailure(error, service, state);
    process.exitCode = 1;
  }
}

async function down(wipe) {
  const state = await readState(localDir);
  if (state) {
    for (const service of ['netlify', 'gateway']) {
      if (serviceAlive(state, service)) await stopGroup(state.pids[service]);
    }
    await composeCommand(['down', ...(wipe ? ['--volumes'] : [])], buildEnv(state, localDir));
    state.pids = {};
    state.pidStarts = {};
    await saveState(localDir, state);
  } else if (wipe) {
    // Recover orphaned project volumes even when the state file was lost.
    const containers = (await command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim().split('\n').filter(Boolean);
    if (containers.length) await command('docker', ['rm', '-f', ...containers]);
    const volumes = (await command('docker', ['volume', 'ls', '-q', '--filter', `name=${project}_`])).stdout.trim().split('\n').filter(name => name.startsWith(`${project}_`));
    if (volumes.length) await command('docker', ['volume', 'rm', ...volumes]);
  }
  if (wipe) await rm(localDir, { recursive: true, force: true });
}

async function logs(service) {
  const state = await readState(localDir);
  for (const name of service ? [service] : services) {
    process.stdout.write(`== ${name} ==\n`);
    if (['netlify', 'gateway'].includes(name)) process.stdout.write(await tail(path.join(localDir, 'logs', `${name}.log`), 200));
    else if (state) {
      const result = await composeCommand(['logs', '--tail', '200', name], buildEnv(state, localDir));
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'up') return up();
  if (args.command === 'down') return down(args.wipe);
  if (args.command === 'logs') return logs(args.service);
  const state = await readState(localDir);
  if (args.command === 'status') { process.stdout.write(JSON.stringify(await collectStatus(state)) + '\n'); return; }
  if (!state) throw new Error('state_missing');
  const server = startGateway(state.ports.gateway,
    { key: await readFile(path.join(localDir, 'certs/tls.key')), cert: await readFile(path.join(localDir, 'certs/tls.crt')) },
    { dex: state.ports.dex, synapse: state.synapsePort, netlify: state.ports.netlify });
  await new Promise((resolve, reject) => server.once('error', reject).listen(state.ports.gateway, '127.0.0.1', resolve));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
