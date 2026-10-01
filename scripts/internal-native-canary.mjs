#!/usr/bin/env node
// An opt-in, isolated native fixture. This launcher never borrows an existing
// Codex/Claude process, browser profile, Khala state directory, or tmux server.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { allocateNamespace, fingerprintEffectiveConfig, validateCandidate, validateJournal, verifyArtifact, writeEvidence } from './acceptance/candidate.ts';

const [action, directory, ...args] = process.argv.slice(2);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = name => { throw Object.assign(new Error(name), { stage: name }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileDigest = file => digest(fs.readFileSync(file));
const sessionDigest = (harness, id) => createHash('sha256').update(['khala.internal.session.v1', harness, id].join('\0')).digest('base64url');
const load = () => {
  if (!directory || !path.isAbsolute(directory)) stage('run_directory');
  const file = path.join(directory, 'run.json');
  if (!fs.existsSync(file)) stage('run_missing');
  const stat = fs.statSync(directory);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) stage('run_permissions');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const save = run => fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
const checked = (bin, argv, env) => {
  const result = spawnSync(bin, argv, { env, encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) stage(`command_${path.basename(bin)}_${result.error?.code ?? result.status}`);
  return result.stdout.trim();
};
const environment = run => ({
  HOME: run.home, CODEX_HOME: path.join(run.home, '.codex'),
  XDG_STATE_HOME: path.join(directory, 'state'), XDG_DATA_HOME: path.join(directory, 'data'),
  XDG_CONFIG_HOME: path.join(directory, 'config'), TMPDIR: directory,
  PATH: `${run.bin}:${path.dirname(process.execPath)}:${path.dirname(run.khala)}:${path.dirname(run.claude)}:/usr/bin:/bin`,
  TERM: 'xterm-256color', LANG: 'C.UTF-8',
  NODE_OPTIONS: `--import=${path.join(repositoryRoot, 'scripts/internal-native-loopback.mjs')}`,
  KHALA_INTERNAL_CANARY_DENIAL_FILE: path.join(directory, 'network-denials'),
  // Provider credentials may be supplied to the native CLIs by their own
  // private login files. No host HOME, cloud token, or hosted Khala URL is inherited.
});
const tmux = (run, argv) => checked('/usr/bin/tmux', ['-S', run.socket, ...argv], environment(run));
const exists = p => fs.existsSync(p);
const status = run => {
  let parsed;
  try { parsed = JSON.parse(checked(process.execPath, [run.khala, 'status'], environment(run))); }
  catch { stage('khala_status'); }
  return parsed.configuration;
};
const ready = run => {
  const result = status(run);
  for (const name of ['codex', 'claude']) {
    const h = result.harnesses?.find(item => item.harness === name);
    if (name === 'codex' && run.codexRoute === 'manual-pinned-0.160.0') {
      if (run.versions?.codex !== 'codex-cli 0.160.0') stage('codex_native_version_unsupported');
      const listing = JSON.parse(checked(run.codex, ['mcp', 'list', '--json'], environment(run)));
      const entry = Array.isArray(listing) ? listing.find(item => item.name === 'khala') : null;
      const expected = { HOME: run.home, XDG_STATE_HOME: path.join(directory, 'state'),
        XDG_DATA_HOME: path.join(directory, 'data') };
      if (entry?.command !== process.execPath || JSON.stringify(entry.args) !== JSON.stringify([run.khala, 'mcp-serve'])
        || Object.entries(expected).some(([key, value]) => entry.env?.[key] !== value)) stage('codex_mcp_private_roots');
      continue;
    }
    if (!h?.version?.supported || !h.version.detected) stage(`${name}_version`);
    if (h.route !== 'native_cli_queue') stage(`${name}_route`);
    if (h.components?.some(item => item.state !== 'ready')) stage(`${name}_setup_or_trust`);
  }
  return result;
};
const authenticated = run => {
  const env = environment(run);
  for (const [name, bin, argv] of [['codex', run.codex, ['login', 'status']], ['claude', run.claude, ['auth', 'status']]]) {
    const result = spawnSync(bin, argv, { env, encoding: 'utf8', timeout: 20_000 });
    if (result.error || result.status !== 0) stage(`${name}_provider_auth`);
    if (name === 'claude') {
      let body;
      try { body = JSON.parse(result.stdout); } catch { stage('claude_provider_auth'); }
      if (body.loggedIn !== true) stage('claude_provider_auth');
    }
  }
};
const files = root => {
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() && file.endsWith('.jsonl') ? [file] : [];
  });
};
const sessionFile = (run, harness, id) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) stage(`${harness}_session_id`);
  const root = harness === 'codex' ? path.join(run.home, '.codex', 'sessions') : path.join(run.home, '.claude', 'projects');
  const matches = files(root).filter(file => path.basename(file).includes(id) && fs.statSync(file).mtimeMs >= run.agentsStartedAt);
  if (matches.length !== 1) stage(`${harness}_exact_session`);
  const rows = fs.readFileSync(matches[0], 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const assistantTurn = rows.some(row => harness === 'codex'
    ? row.type === 'response_item' && row.payload?.type === 'message' && row.payload?.role === 'assistant'
    : row.type === 'assistant' && row.message?.role === 'assistant'
      && typeof row.message.model === 'string' && row.message.model.includes(run.models.claude));
  if (!assistantTurn) stage(`${harness}_model_turn`);
  if (harness === 'codex' && !rows.some(row => row.type === 'turn_context'
    && row.payload?.model === run.models.codex && row.payload?.cwd === directory)) stage('codex_model_identity');
  return matches[0];
};
const childAlive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const ownerGet = async (run, suffix) => {
  if (!run.browserPort) stage('browser_not_ready');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${run.browserPort}`);
  try {
    const page = browser.contexts()[0]?.pages().find(item => item.url().startsWith(run.origin));
    if (!page) stage('owner_browser_page');
    const result = await page.evaluate(async ({ channelId, suffix }) => {
      const requestSecret = sessionStorage.getItem('khala.requestSecret');
      if (!requestSecret) return { status: 401, body: null };
      const response = await fetch(`/api/v1/channels/${encodeURIComponent(channelId)}${suffix}`, {
        credentials: 'same-origin', headers: { 'x-khala-request-secret': requestSecret },
      });
      return { status: response.status, body: response.ok ? await response.json() : null };
    }, { channelId: run.channelId, suffix });
    if (result.status !== 200) stage(`owner_${suffix.split('/').at(-1)}_${result.status}`);
    return result.body;
  } finally { await browser.close(); }
};
const nativeInterval = (run, harness) => {
  const file = sessionFile(run, harness, run.sessions[harness]);
  const offset = run.challenge.offsets[harness];
  const raw = fs.readFileSync(file);
  if (raw.length < offset) stage(`${harness}_rollout_replaced`);
  return raw.subarray(offset).toString('utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
};
const modelEvidence = (rows, harness, received, sent) => {
  const calls = rows.flatMap((row, index) => {
    if (harness === 'codex') {
      const payload = row.type === 'response_item' && row.payload?.type === 'mcp_tool_call' ? row.payload : null;
      return payload ? [{ index, name: String(payload.tool ?? payload.name ?? ''), input: JSON.stringify(payload.arguments ?? {}) }] : [];
    }
    return row.type === 'assistant' && Array.isArray(row.message?.content)
      ? row.message.content.filter(item => item?.type === 'tool_use')
        .map(item => ({ index, name: String(item.name ?? ''), input: JSON.stringify(item.input ?? {}) })) : [];
  });
  const read = calls.find(call => /(?:^|__)khala_read$/.test(call.name));
  const visible = read !== undefined && rows.some((row, index) => index >= read.index
    && JSON.stringify(row).includes(received)
    && (harness === 'codex' ? row.type === 'response_item' && row.payload?.type === 'mcp_tool_call'
      : row.type === 'user' && row.message?.content?.some?.(item => item?.type === 'tool_result')));
  const sendCall = calls.some(call => /(?:^|__)khala_send$/.test(call.name) && call.input.includes(sent));
  return { readCall: read !== undefined, visible, sendCall };
};
const acknowledged = (facts, eventId, binding) => facts.filter(fact => fact.receipt?.kind === 'agent_acknowledged'
  && fact.receipt.source === 'agent' && fact.receipt.bindingId === binding.bindingId
  && fact.receipt.generation === binding.generation && fact.events?.some(event => event.eventId === eventId));

async function main() {
  if (action === 'init') {
    const tarball = directory;
    if (!tarball || !path.isAbsolute(tarball) || !exists(tarball)) stage('tarball_argument');
    if (args.length !== 4 || args[0] !== '--codex-bin' || args[2] !== '--codex-sha256') stage('codex_pin_required');
    const codexBinary = args[1];
    const codexSha256 = args[3];
    if (!path.isAbsolute(codexBinary) || !exists(codexBinary) || !/^[a-f0-9]{64}$/.test(codexSha256)) stage('codex_pin_invalid');
    if (fileDigest(codexBinary) !== codexSha256) stage('codex_pin_mismatch');
    const pinnedVersion = checked(codexBinary, ['--version'], process.env);
    if (!['codex-cli 0.159.3', 'codex-cli 0.160.0'].includes(pinnedVersion)) stage('codex_native_version_unsupported');
    let provenance;
    try { provenance = JSON.parse(fs.readFileSync(`${tarball}.provenance.json`, 'utf8')); }
    catch { stage('tarball_provenance'); }
    if (provenance.v !== 1 || provenance.package !== '@aiur/khala' || provenance.clean !== true
      || provenance.sha256 !== fileDigest(tarball)
      || provenance.commit !== checked('/usr/bin/git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], process.env)) stage('tarball_identity');
    // Chromium's profile singleton socket cannot use the long agent TMPDIR.
    const root = fs.mkdtempSync('/tmp/khala-native-');
    fs.chmodSync(root, 0o700);
    for (const name of ['home', 'state', 'data', 'config', 'browser', 'prefix', 'npm-cache', 'bin']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    fs.symlinkSync(codexBinary, path.join(root, 'bin', 'codex'));
    const privateTarball = path.join(root, 'package.tgz');
    fs.copyFileSync(tarball, privateTarball);
    fs.chmodSync(privateTarball, 0o600);
    verifyArtifact(privateTarball, provenance.sha256);
    checked('npm', ['install', '-g', '--offline', '--prefix', path.join(root, 'prefix'), privateTarball], {
      ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
    });
    const find = bin => { const result = spawnSync('/usr/bin/which', [bin], { encoding: 'utf8' }); return result.status === 0 ? fs.realpathSync(result.stdout.trim()) : null; };
    const run = { v: 1, id: randomBytes(12).toString('hex'), home: path.join(root, 'home'), socket: path.join(root, 'tmux.sock'),
      khala: fs.realpathSync(path.join(root, 'prefix', 'bin', 'khala')), codex: codexBinary, claude: find('claude'), bin: path.join(root, 'bin'),
      codexSha256, codexRoute: pinnedVersion === 'codex-cli 0.159.3' ? 'sync-pinned-0.159.3' : 'manual-pinned-0.160.0',
      tarball: privateTarball, tarballSha256: provenance.sha256, packageCommit: provenance.commit,
      lockfileSha256: fileDigest(path.join(repositoryRoot, 'pnpm-lock.yaml')), createdAt: Date.now() };
    if (!run.khala || !run.codex || !run.claude) stage('installed_binaries');
    fs.writeFileSync(path.join(root, 'run.json'), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ kind: 'prepared', directory: root, id: run.id, packageCommit: run.packageCommit,
      packageSha256: run.tarballSha256, codexVersion: pinnedVersion, codexSha256, codexRoute: run.codexRoute,
      next: 'Log in under this private HOME, run setup, then start-agents.' }) + '\n');
    return;
  }
  const run = load();
  if (action === 'setup') {
    const env = environment(run);
    const planned = spawnSync(process.execPath, [run.khala, 'setup', '--dry-run'], { env, encoding: 'utf8', timeout: 30_000 });
    let dry;
    try { dry = JSON.parse(planned.stdout); } catch { stage('setup_plan_report'); }
    if (!dry.planDigest) stage('setup_plan');
    const execution = spawnSync(process.execPath, [run.khala, 'setup', '--confirm', dry.planDigest], { env, encoding: 'utf8', timeout: 60_000 });
    let applied;
    try { applied = JSON.parse(execution.stdout); } catch { stage('setup_apply_report'); }
    if (run.codexRoute !== 'manual-pinned-0.160.0' && !applied.ok) stage('setup_apply');
    const claude = status(run).harnesses?.find(item => item.harness === 'claude');
    if (!claude?.version?.supported || claude.route !== 'native_cli_queue'
      || claude.components?.some(item => item.state !== 'ready')) stage('claude_setup');
    process.stdout.write(JSON.stringify({ kind: 'setup_applied', id: run.id, next: 'start-agents, then approve native hook trust in each new PTY' }) + '\n');
    return;
  }
  if (action === 'setup-manual-codex') {
    if (run.codexRoute !== 'manual-pinned-0.160.0' || run.agentsStartedAt) stage('manual_route_unavailable');
    const env = environment(run);
    const current = spawnSync(run.codex, ['mcp', 'remove', 'khala'], { env, encoding: 'utf8', timeout: 20_000 });
    if (current.error) stage('codex_mcp_remove');
    checked(run.codex, ['mcp', 'add', 'khala',
      '--env', `HOME=${run.home}`, '--env', `XDG_STATE_HOME=${path.join(directory, 'state')}`,
      '--env', `XDG_DATA_HOME=${path.join(directory, 'data')}`,
      '--env', `NODE_OPTIONS=${env.NODE_OPTIONS}`,
      '--env', `KHALA_INTERNAL_CANARY_DENIAL_FILE=${env.KHALA_INTERNAL_CANARY_DENIAL_FILE}`,
      '--', process.execPath, run.khala, 'mcp-serve'], env);
    const listed = JSON.parse(checked(run.codex, ['mcp', 'list', '--json'], env));
    if (!Array.isArray(listed) || listed.filter(item => item.name === 'khala').length !== 1) stage('codex_mcp_config');
    process.stdout.write(JSON.stringify({ kind: 'manual_codex_mcp_ready', id: run.id,
      route: run.codexRoute, next: 'Run setup for Claude, then start the fresh PTYs.' }) + '\n');
    return;
  }
  if (action === 'auth-handoff') {
    if (run.agentsStartedAt || run.channelId) stage('auth_handoff_too_late');
    const sourceHome = process.env.KHALA_CANARY_AUTH_HOME || os.homedir();
    const entries = [
      [path.join(sourceHome, '.codex', 'auth.json'), path.join(run.home, '.codex', 'auth.json')],
      [path.join(sourceHome, '.claude', '.credentials.json'), path.join(run.home, '.claude', '.credentials.json')],
    ];
    for (const [source, target] of entries) {
      let stat;
      try { stat = fs.lstatSync(source); } catch { stage('provider_auth_source_missing'); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 1024 * 1024) stage('provider_auth_source_unsafe');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); } catch { stage('provider_auth_target_exists'); }
      fs.chmodSync(target, 0o600);
    }
    process.stdout.write(JSON.stringify({ kind: 'private_auth_copied', id: run.id, files: 2,
      next: 'Run auth; no other account settings were imported.' }) + '\n');
    return;
  }
  if (action === 'auth') {
    authenticated(run);
    process.stdout.write(JSON.stringify({ kind: 'provider_auth_ready', id: run.id, providers: ['codex', 'claude'] }) + '\n');
    return;
  }
  if (action === 'start-agents') {
    if (run.agentsStartedAt) stage('agents_already_started');
    const [codexModel, claudeModel] = args;
    if (args.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(codexModel ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(claudeModel ?? '')) stage('model_arguments');
    authenticated(run);
    const codexVersion = checked(run.codex, ['--version'], environment(run));
    const claudeVersion = checked(run.claude, ['--version'], environment(run));
    run.agentsStartedAt = Date.now();
    run.versions = { codex: codexVersion, claude: claudeVersion };
    run.models = { codex: codexModel, claude: claudeModel };
    save(run);
    for (const [name, bin] of [['codex', run.codex], ['claude', run.claude]]) {
      tmux(run, ['new-session', '-d', '-s', name, '-c', directory, '-e', `HOME=${run.home}`, '-e', `CODEX_HOME=${path.join(run.home, '.codex')}`,
        '-e', `XDG_STATE_HOME=${path.join(directory, 'state')}`, '-e', `XDG_DATA_HOME=${path.join(directory, 'data')}`,
        '-e', `XDG_CONFIG_HOME=${path.join(directory, 'config')}`, '-e', `TMPDIR=${directory}`,
        '-e', `NODE_OPTIONS=${environment(run).NODE_OPTIONS}`,
        '-e', `KHALA_INTERNAL_CANARY_DENIAL_FILE=${path.join(directory, 'network-denials')}`, bin,
        '--model', run.models[name], ...(name === 'codex' ? ['--no-daemon'] : [])]);
    }
    process.stdout.write(JSON.stringify({ kind: 'agents_started', id: run.id, versions: run.versions, models: run.models,
      attach: ['codex', 'claude'].map(name => `tmux -S ${run.socket} attach -t ${name}`),
      next: 'Complete a model turn and native hook trust in each PTY; get both native session IDs, then run open.' }) + '\n');
    return;
  }
  if (action === 'open') {
    const [codexId, claudeId] = args;
    if (!codexId || !claudeId || args.length !== 2) stage('session_arguments');
    if (run.channelId) stage('channel_already_open');
    if (checked('/usr/bin/git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], process.env) !== run.packageCommit
      || fileDigest(path.join(repositoryRoot, 'pnpm-lock.yaml')) !== run.lockfileSha256) stage('candidate_drift');
    verifyArtifact(run.tarball, run.tarballSha256);
    if (fileDigest(run.codex) !== run.codexSha256 || checked(run.codex, ['--version'], environment(run))
      !== `codex-cli ${run.codexRoute.endsWith('0.159.3') ? '0.159.3' : '0.160.0'}`) stage('codex_pin_drift');
    for (const name of ['codex', 'claude']) tmux(run, ['has-session', '-t', name]);
    sessionFile(run, 'codex', codexId);
    sessionFile(run, 'claude', claudeId);
    const result = ready(run);
    const observed = Object.fromEntries(['codex', 'claude'].map(name => [name,
      name === 'codex' && run.codexRoute === 'manual-pinned-0.160.0' ? '0.160.0'
        : result.harnesses.find(h => h.harness === name).version.detected]));
    if (!run.versions.codex.includes(observed.codex) || !run.versions.claude.includes(observed.claude)) stage('version_drift');
    const server = spawn(process.execPath, [run.khala, 'internal'], { cwd: directory, env: environment(run), stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let buffer = '';
    const report = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('internal_start_timeout')), 30_000);
      server.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.includes('\n')) { clearTimeout(timeout); try { resolve(JSON.parse(buffer.split('\n')[0])); } catch { reject(new Error('internal_start_report')); } }
      });
      server.once('exit', () => reject(new Error('internal_start_exit')));
    }).catch(error => { server.kill('SIGTERM'); throw error; });
    if (report.kind !== 'running' || report.ok !== true || new URL(report.origin).hostname !== '127.0.0.1') {
      server.kill('SIGTERM'); stage('internal_loopback');
    }
    run.serverPid = server.pid; run.channelId = report.channelId; run.origin = report.origin;
    run.sessions = { codex: codexId, claude: claudeId };
    run.ownerUrl = report.url;
    save(run);
    const lockfileSha256 = run.lockfileSha256;
    const namespace = allocateNamespace(directory);
    run.candidate = {
      lane: 'internal', sourceCommit: run.packageCommit, lockfileSha256,
      components: { web: 'N/A', function: 'N/A', cli: { input: digest(`${run.packageCommit}:${lockfileSha256}`), artifact: run.tarballSha256 },
        connector: 'N/A', hook: 'N/A', plugin: 'N/A' },
      configSha256: fingerprintEffectiveConfig({ mode: 'internal', transport: 'loopback', browser: 'chromium' }),
      images: {}, nativeVersions: { ...observed, codexBinarySha256: run.codexSha256, codexRoute: run.codexRoute },
      differences: { origin: report.origin, csp: 'internal', provider: 'native' }, namespace,
    };
    validateCandidate(run.candidate);
    save(run);
    server.stdout.destroy();
    server.unref();
    process.stdout.write(JSON.stringify({ kind: 'channel_open', id: run.id, channelId: run.channelId, origin: run.origin,
      ownerUrl: report.url, channelUrl: `${report.origin}/channels/${report.channelId}`,
      next: 'Use this owner URL only in an isolated headless Chromium profile; approve the two exact native sessions.' }) + '\n');
    return;
  }
  if (action === 'challenge') {
    if (!run.browserPort || !run.browserPid || !childAlive(run.browserPid)) stage('browser_not_ready');
    if (run.challenge) stage('challenge_already_issued');
    const listed = await ownerGet(run, '/bindings');
    const selected = {};
    for (const name of ['codex', 'claude']) {
      const matches = listed.bindings?.filter(item => item.binding?.harness === name
        && item.binding.sessionId === sessionDigest(name, run.sessions?.[name]));
      if (matches?.length !== 1) stage(`${name}_exact_binding`);
      const { binding, view, idleDelivery } = matches[0];
      if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) stage(`${name}_binding_generation`);
      if (!view || !['sync', 'steer', 'async', null].includes(view.effective)) stage(`${name}_mode_view`);
      selected[name] = { bindingId: binding.bindingId, generation: binding.generation,
        participantId: binding.agentParticipantId, mode: view.effective ?? 'manual', idleWake: idleDelivery };
    }
    const nonce = randomBytes(10).toString('hex');
    const body = `Khala local canary ${run.id} ${nonce}. Add 7 and 11. Codex send exactly "18 ${nonce} codex"; Claude send exactly "18 ${nonce} claude" through Khala. Then each read and acknowledge the peer reply.`;
    const offsets = Object.fromEntries(['codex', 'claude'].map(name => [name,
      fs.statSync(sessionFile(run, name, run.sessions[name])).size]));
    run.challenge = { nonce, body, issuedAt: Date.now(), bindings: selected, offsets };
    save(run);
    process.stdout.write(JSON.stringify({ kind: 'challenge_ready', runId: run.id, nonce, body,
      bindings: selected, next: 'Send this through the isolated browser, then let both existing PTYs read, ACK and reply.' }) + '\n');
    return;
  }
  if (action === 'verify') {
    if (!run.challenge || !run.candidate || !run.browserPort) stage('challenge_not_ready');
    if (exists(path.join(directory, 'network-denials')) && fs.statSync(path.join(directory, 'network-denials')).size > 0) stage('hosted_network_attempt');
    const timeline = await ownerGet(run, '/timeline?limit=100');
    const facts = (await ownerGet(run, '/receipts')).facts;
    const challenge = timeline.events?.filter(event => event.content?.body === run.challenge.body);
    if (challenge?.length !== 1 || challenge[0].participant?.kind !== 'human') stage('human_browser_send');
    const replies = {};
    for (const name of ['codex', 'claude']) {
      const binding = run.challenge.bindings[name];
      const expected = `18 ${run.challenge.nonce} ${name}`;
      const events = timeline.events.filter(event => event.participant?.participantId === binding.participantId
        && event.content?.body === expected);
      if (events.length !== 1) stage(`${name}_durable_reply`);
      replies[name] = events[0];
      if (acknowledged(facts, challenge[0].eventId, binding).length !== 1) stage(`${name}_human_message_ack`);
      if (!run.browserProofs?.includes(digest(expected))) stage(`${name}_browser_reload`);
      const own = modelEvidence(nativeInterval(run, name), name, run.challenge.body, expected);
      if (!own.readCall || !own.visible || !own.sendCall) stage(`${name}_model_read_ack_reply`);
    }
    const paths = [];
    for (const [sender, recipient] of [['codex', 'claude'], ['claude', 'codex']]) {
      const event = replies[sender];
      const binding = run.challenge.bindings[recipient];
      if (acknowledged(facts, event.eventId, binding).length !== 1) stage(`${recipient}_peer_ack`);
      const peer = modelEvidence(nativeInterval(run, recipient), recipient, event.content.body,
        `18 ${run.challenge.nonce} ${recipient}`);
      if (!peer.readCall || !peer.visible) stage(`${recipient}_peer_model_read`);
      const operationId = `native-${run.id}-${sender}`;
      const journal = ['pending', 'released', 'model-consumed', 'acknowledged', 'durable-browser-visible']
        .map((stageName, index) => ({ stage: stageName, operationId, eventId: event.eventId,
          bindingId: binding.bindingId, generation: binding.generation,
          origin: index === 2 || index === 3 ? 'model' : index === 4 ? 'browser' : 'server' }));
      validateJournal(journal);
      const candidate = sender === 'codex' ? run.candidate : { ...run.candidate, namespace: allocateNamespace(directory) };
      paths.push(writeEvidence(directory, candidate, journal));
    }
    process.stdout.write(JSON.stringify({ kind: 'pass', runId: run.id, channelId: run.channelId,
      eventIds: { human: challenge[0].eventId, codex: replies.codex.eventId, claude: replies.claude.eventId },
      receiptIds: facts.filter(fact => fact.receipt?.kind === 'agent_acknowledged').map(fact => fact.receipt.receiptId),
      evidence: paths }) + '\n');
    return;
  }
  if (action === 'browser') {
    if (!run.ownerUrl || !run.serverPid || !childAlive(run.serverPid)) stage('channel_not_running');
    if (run.browserPid && childAlive(run.browserPid)) stage('browser_already_running');
    const executable = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
    if (!path.isAbsolute(executable) || !exists(executable)) stage('chromium_missing');
    const profile = path.join(directory, 'browser');
    const browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost', 'about:blank'],
    { env: environment(run), stdio: 'ignore', detached: true });
    browser.unref();
    run.browserPid = browser.pid;
    save(run);
    try {
      const portFile = path.join(profile, 'DevToolsActivePort');
      const deadline = Date.now() + 15_000;
      while (!exists(portFile) && Date.now() < deadline && childAlive(browser.pid)) await new Promise(resolve => setTimeout(resolve, 100));
      if (!exists(portFile)) stage('browser_cdp');
      const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (!Number.isInteger(port) || port < 1) stage('browser_cdp');
      const connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        const context = connection.contexts()[0];
        if (!context) stage('browser_context');
        const page = await context.newPage();
        let blocked = 0;
        await page.route('**/*', route => {
          if (new URL(route.request().url()).origin === run.origin) return route.continue();
          blocked++;
          return route.abort();
        });
        await page.goto(run.ownerUrl, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: 'Channel', level: 1 }).waitFor({ timeout: 15_000 });
        run.browserPort = port; delete run.ownerUrl;
        save(run);
        process.stdout.write(JSON.stringify({ kind: 'browser_ready', id: run.id, cdp: `http://127.0.0.1:${port}`,
          channelUrl: `${run.origin}/channels/${run.channelId}`, blockedExternalRequests: blocked,
          next: 'Drive this isolated browser through CDP; verify approvals, messages, and a fresh reload.' }) + '\n');
      } finally { await connection.close(); }
    } catch (error) {
      if (childAlive(browser.pid)) process.kill(-browser.pid, 'SIGTERM');
      delete run.browserPid;
      save(run);
      throw error;
    }
    return;
  }
  if (action === 'status') {
    const state = { id: run.id, versions: run.versions ?? null, models: run.models ?? null, sessions: run.sessions ?? null,
      channelId: run.channelId ?? null, serverAlive: run.serverPid ? childAlive(run.serverPid) : false,
      browserAlive: run.browserPid ? childAlive(run.browserPid) : false,
      deniedOutboundAttempts: exists(path.join(directory, 'network-denials'))
        ? fs.readFileSync(path.join(directory, 'network-denials'), 'utf8').split('\n').filter(Boolean).length : 0,
      browserCdp: run.browserPort ? `http://127.0.0.1:${run.browserPort}` : null };
    process.stdout.write(JSON.stringify({ kind: 'candidate_status', ...state }) + '\n');
    return;
  }
  if (action === 'stop' || action === 'destroy') {
    if (run.browserPid && childAlive(run.browserPid)) process.kill(-run.browserPid, 'SIGTERM');
    if (run.serverPid && childAlive(run.serverPid)) process.kill(-run.serverPid, 'SIGTERM');
    for (const name of ['codex', 'claude']) { try { tmux(run, ['kill-session', '-t', name]); } catch { /* already stopped */ } }
    try { tmux(run, ['kill-server']); } catch { /* already stopped */ }
    const deadline = Date.now() + 5_000;
    while ((run.serverPid && childAlive(run.serverPid) || run.browserPid && childAlive(run.browserPid)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (run.serverPid && childAlive(run.serverPid) || run.browserPid && childAlive(run.browserPid)) stage('cleanup_orphaned_process');
    delete run.ownerUrl;
    save(run);
    if (action === 'destroy') {
      if (!fs.realpathSync(directory).startsWith('/tmp/khala-native-')) stage('destroy_path');
      fs.rmSync(directory, { recursive: true, force: false });
    }
    process.stdout.write(JSON.stringify({ kind: 'stopped', id: run.id, directory, next: 'Remove this private run directory when evidence review is complete.' }) + '\n');
    return;
  }
  stage('usage');
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, kind: 'unproven', stage: error.stage ?? error.message, directory: directory || null }) + '\n');
  process.exitCode = 1;
});
