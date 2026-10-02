#!/usr/bin/env node
// Local-only native participants for the disposable hosted acceptance run.
// No production Khala state, grant, browser profile, or active session is read.
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { modelEvidence } from './internal-native-model-evidence.mjs';

const [action, directory, ...args] = process.argv.slice(2);
const fail = code => { throw new Error(`external_native_${code}`); };
const privateFile = (file, maxBytes = 1024 * 1024) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maxBytes) fail('private_file_required');
  return file;
};
const privateDirectory = file => {
  if (!path.isAbsolute(file)) fail('absolute_directory_required');
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0) fail('private_directory_required');
};
const checked = (bin, argv, env = process.env) => {
  const result = spawnSync(bin, argv, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0) fail(`command_${path.basename(bin)}_failed`);
  return result.stdout.trim();
};
const safeWord = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const stateFile = directory => path.join(directory, 'native-sessions.json');
const load = directory => {
  privateDirectory(directory);
  return JSON.parse(fs.readFileSync(privateFile(stateFile(directory)), 'utf8'));
};
const save = (directory, state) => fs.writeFileSync(stateFile(directory), JSON.stringify({ ...state,
  sessions: ['codex', 'claude'].filter(actor => state.actors?.[actor]).map(actor => ({ actor, ...state.actors[actor] })),
}) + '\n', { mode: 0o600 });
const tmux = (state, argv) => checked('/usr/bin/tmux', ['-S', state.socket, ...argv], state.env);

function sourceAuth(sourceHome, privateHome) {
  const codex = privateFile(path.join(sourceHome, '.codex', 'auth.json'));
  const claude = JSON.parse(fs.readFileSync(privateFile(path.join(sourceHome, '.claude', '.credentials.json')), 'utf8'));
  const onboarding = JSON.parse(fs.readFileSync(privateFile(path.join(sourceHome, '.claude.json')), 'utf8'));
  if (!claude.claudeAiOauth?.accessToken || !claude.claudeAiOauth?.refreshToken
    || onboarding.hasCompletedOnboarding !== true || onboarding.installMethod !== 'native') fail('provider_auth_schema');
  for (const relative of ['.codex', '.claude']) fs.mkdirSync(path.join(privateHome, relative), { mode: 0o700 });
  fs.copyFileSync(codex, path.join(privateHome, '.codex', 'auth.json'), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(privateHome, '.codex', 'auth.json'), 0o600);
  fs.writeFileSync(path.join(privateHome, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: claude.claudeAiOauth }) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(privateHome, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: onboarding.lastOnboardingVersion,
    installMethod: 'native',
  }) + '\n', { flag: 'wx', mode: 0o600 });
}

function sessions(root, since) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return sessions(file, since);
    return entry.isFile() && file.endsWith('.jsonl') && fs.statSync(file).mtimeMs >= since ? [file] : [];
  });
}

function observedSession(state, actor) {
  const root = actor === 'codex' ? path.join(state.home, '.codex', 'sessions') : path.join(state.home, '.claude', 'projects');
  const candidates = sessions(root, state.startedAt).flatMap(file => {
    const match = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(file);
    if (!match) return [];
    const data = fs.readFileSync(file, 'utf8');
    const rows = data.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const authored = rows.some(row => actor === 'codex'
      ? row.type === 'response_item' && row.payload?.type === 'message' && row.payload?.role === 'assistant'
      : row.type === 'assistant' && row.message?.role === 'assistant');
    return authored ? [{ sessionId: match[1], transcript: file }] : [];
  });
  if (candidates.length !== 1) fail(`${actor}_exact_session_unproven`);
  return candidates[0];
}

export function proofFingerprint(state, actor, sessionId) {
  const directory = path.join(state.roots.state, 'khala', 'hosted', createHash('sha256')
    .update(JSON.stringify(['khala.hosted.session.v1', actor, sessionId, state.directory])).digest('hex'), 'state');
  const file = path.join(directory, 'ledger.sqlite');
  if (!fs.existsSync(file)) return null;
  privateFile(file, 32 * 1024 * 1024);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT private_key FROM bootstrap_signer WHERE singleton = 1').get();
    if (!(row?.private_key instanceof Uint8Array)) fail('proof_signer_unavailable');
    const key = createPrivateKey({ key: Buffer.from(row.private_key), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') fail('proof_signer_invalid');
    const publicJwk = createPublicKey(key).export({ format: 'jwk' });
    if (typeof publicJwk.x !== 'string') fail('proof_signer_invalid');
    return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: publicJwk.x })).digest('base64url');
  } finally { db.close(); }
}

function nativeRows(session) {
  if (!Number.isSafeInteger(session.baselineOffset) || session.baselineOffset < 0) fail('baseline_missing');
  const bytes = fs.readFileSync(privateFile(session.transcript, 32 * 1024 * 1024));
  if (bytes.length < session.baselineOffset) fail('transcript_replaced');
  return bytes.subarray(session.baselineOffset).toString('utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function main() {
  if (!directory) fail('directory_required');
  if (action === 'launch') {
    privateDirectory(directory);
    if (args.length !== 0 || fs.existsSync(stateFile(directory))) fail('already_launched');
    const descriptor = process.env.KHALA_E2E_DISPOSABLE_ENV;
    const cli = process.env.KHALA_EXTERNAL_CLI;
    const origin = process.env.KHALA_EXTERNAL_ORIGIN;
    if (!descriptor || !path.isAbsolute(descriptor) || !cli || !path.isAbsolute(cli)
      || !/^https:\/\/127\.0\.0\.1:\d+$/u.test(origin ?? '') || !process.env.NODE_EXTRA_CA_CERTS)
      fail('disposable_environment_required');
    privateFile(descriptor);
    const privateHome = path.join(directory, 'home');
    fs.mkdirSync(privateHome, { mode: 0o700 });
    sourceAuth(os.userInfo().homedir, privateHome);
    const codex = checked('/usr/bin/which', ['codex']);
    const claude = checked('/usr/bin/which', ['claude']);
    const versions = { codex: checked(codex, ['--version']), claude: checked(claude, ['--version']) };
    if (versions.codex !== 'codex-cli 0.160.0' || !/^2\.1\.\d+/u.test(versions.claude)) fail('native_version_unproven');
    const roots = Object.fromEntries(['state', 'data', 'config', 'tmp'].map(name => {
      const file = path.join(directory, name); fs.mkdirSync(file, { mode: 0o700 }); return [name, file];
    }));
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin, { mode: 0o700 });
    for (const [name, target] of [['codex', codex], ['claude', claude], ['node', process.execPath]]) {
      fs.symlinkSync(target, path.join(bin, name));
    }
    const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TERM: 'xterm-256color',
      HOME: privateHome, CODEX_HOME: path.join(privateHome, '.codex'), XDG_STATE_HOME: roots.state,
      XDG_DATA_HOME: roots.data, XDG_CONFIG_HOME: roots.config, TMPDIR: roots.tmp,
      KHALA_APP_ORIGIN: origin, KHALA_EXTERNAL_ORIGIN: origin,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS };
    // The installed setup owns Claude hooks/plugin. Codex 0.160 needs the
    // independently pinned MCP entry below; setup's claimed native route alone
    // is not acceptance evidence.
    const planned = spawnSync(process.execPath, [cli, 'setup', '--dry-run'], { env, encoding: 'utf8', timeout: 30_000 });
    let dry;
    try { dry = JSON.parse(planned.stdout); } catch { fail('setup_plan_report'); }
    if (dry.planDigest) {
      const execution = spawnSync(process.execPath, [cli, 'setup', '--confirm', dry.planDigest],
        { env, encoding: 'utf8', timeout: 60_000 });
      let applied;
      try { applied = JSON.parse(execution.stdout); } catch { fail('setup_apply_report'); }
      if (!Array.isArray(applied.harnesses)) fail('setup_apply');
    } else if (dry.operations?.length) fail('setup_plan');
    const status = JSON.parse(checked(process.execPath, [cli, 'status'], env));
    const claudeSetup = status.configuration?.harnesses?.find(item => item.harness === 'claude');
    if (!claudeSetup?.version?.supported || !claudeSetup.components?.length
      || claudeSetup.components.some(item => item.state !== 'ready')) fail('claude_setup');
    const removal = spawnSync(codex, ['mcp', 'remove', 'khala'], { env, encoding: 'utf8', timeout: 20_000 });
    if (removal.error) fail('codex_mcp_remove');
    checked(codex, ['mcp', 'add', 'khala', '--env', `HOME=${privateHome}`, '--env', `XDG_STATE_HOME=${roots.state}`,
      '--env', `XDG_DATA_HOME=${roots.data}`, '--env', `XDG_CONFIG_HOME=${roots.config}`,
      '--env', `KHALA_APP_ORIGIN=${origin}`, '--env', `KHALA_EXTERNAL_ORIGIN=${origin}`,
      '--env', `NODE_EXTRA_CA_CERTS=${env.NODE_EXTRA_CA_CERTS}`,
      '--', process.execPath, cli, 'mcp-serve'], env);
    const listing = JSON.parse(checked(codex, ['mcp', 'list', '--json'], env));
    const entry = Array.isArray(listing) ? listing.find(item => item.name === 'khala') : null;
    if (entry?.transport?.command !== process.execPath || entry.transport.env?.XDG_STATE_HOME !== roots.state
      || entry.transport.env?.HOME !== privateHome || entry.transport.env?.KHALA_APP_ORIGIN !== origin)
      fail('codex_mcp_private_roots');
    const state = { v: 1, id: randomBytes(12).toString('hex'), directory, home: privateHome,
      socket: path.join(directory, 'tmux.sock'), roots, cli, origin, codex, claude, versions, env,
      startedAt: Date.now(), actors: {} };
    save(directory, state);
    for (const [actor, bin, model] of [['codex', codex, 'gpt-6.1-sol'], ['claude', claude, 'sonnet']]) {
      const launcher = path.join(directory, `${actor}-launch.sh`);
      fs.writeFileSync(launcher, `#!/bin/sh\nexec ${safeWord(bin)} --model ${safeWord(model)}\n`, { mode: 0o700 });
      tmux(state, ['new-session', '-d', '-s', actor, '-c', directory, launcher]);
    }
    process.stdout.write(JSON.stringify({ kind: 'native_started', versions }) + '\n');
    return;
  }
  const state = load(directory);
  if (action === 'prompt') {
    if (args.length !== 2 || !['codex', 'claude'].includes(args[0])) fail('prompt_arguments');
    privateFile(args[1]);
    const buffer = `khala-${state.id}`;
    tmux(state, ['load-buffer', '-b', buffer, args[1]]);
    try { tmux(state, ['paste-buffer', '-d', '-b', buffer, '-t', args[0]]); tmux(state, ['send-keys', '-t', args[0], 'Enter']); }
    finally { try { tmux(state, ['delete-buffer', '-b', buffer]); } catch { /* best effort */ } }
    process.stdout.write(JSON.stringify({ kind: 'prompt_delivered', actor: args[0] }) + '\n');
    return;
  }
  if (action === 'inspect') {
    if (args.length) fail('inspect_arguments');
    for (const actor of ['codex', 'claude']) {
      tmux(state, ['has-session', '-t', actor]);
      const pid = Number(tmux(state, ['display-message', '-p', '-t', actor, '#{pane_pid}']));
      if (!Number.isSafeInteger(pid) || pid < 2 || fs.statSync(`/proc/${pid}`).uid !== process.getuid()) fail(`${actor}_process_unproven`);
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const processStartTicks = stat.split(') ').at(-1)?.trim().split(/\s+/u)[19];
      const command = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (!processStartTicks || !command.includes('--model')) fail(`${actor}_process_unproven`);
      const local = { ...observedSession(state, actor), pid, processStartTicks,
        cliVersion: state.versions[actor],
        home: state.home, xdgStateHome: state.roots.state, xdgDataHome: state.roots.data };
      const previous = state.actors[actor];
      if (previous?.sessionId && previous.sessionId !== local.sessionId) fail(`${actor}_session_replaced`);
      if (previous?.pid && (previous.pid !== pid || previous.processStartTicks !== processStartTicks)) fail(`${actor}_process_replaced`);
      state.actors[actor] = { ...local, ...(previous?.baselineOffset === undefined ? {} : { baselineOffset: previous.baselineOffset }) };
      const sessionFingerprint = proofFingerprint(state, actor, local.sessionId);
      if (sessionFingerprint) state.actors[actor].sessionFingerprint = sessionFingerprint;
    }
    if (state.actors.codex.sessionId === state.actors.claude.sessionId) fail('duplicate_session');
    // A global `khala status` has no native session selector. Read only the
    // per-session current binding in the connector's private state instead.
    for (const actor of ['codex', 'claude']) {
      const session = state.actors[actor];
      if (!session.sessionFingerprint) continue;
      const hash = createHash('sha256').update(JSON.stringify([
        'khala.hosted.session.v1', actor, session.sessionId, state.directory,
      ])).digest('hex');
      const current = path.join(state.roots.state, 'khala', 'hosted', hash, 'current-binding.json');
      if (!fs.existsSync(current)) continue;
      const held = JSON.parse(fs.readFileSync(privateFile(current), 'utf8'));
      if (held?.sessionId !== `agent_${session.sessionFingerprint}`
        || typeof held.bindingId !== 'string' || !Number.isSafeInteger(held.generation)
        || typeof held.agentParticipantId !== 'string') fail(`${actor}_binding_mismatch`);
      Object.assign(session, { bindingId: held.bindingId, generation: held.generation,
        agentParticipantId: held.agentParticipantId });
    }
    save(directory, state);
    process.stdout.write(JSON.stringify({ kind: 'native_sessions_observed', actors: ['codex', 'claude'] }) + '\n');
    return;
  }
  if (action === 'mark') {
    if (args.length !== 0) fail('mark_arguments');
    for (const actor of ['codex', 'claude']) {
      const session = state.actors[actor];
      if (!session?.bindingId || !Number.isSafeInteger(session.generation)) fail(`${actor}_binding_unproven`);
      if (session.baselineOffset !== undefined) fail('baseline_already_marked');
      session.baselineOffset = fs.statSync(privateFile(session.transcript, 32 * 1024 * 1024)).size;
    }
    save(directory, state);
    process.stdout.write(JSON.stringify({ kind: 'native_baseline_marked' }) + '\n');
    return;
  }
  if (action === 'witness') {
    if (args.length !== 1) fail('witness_arguments');
    const input = JSON.parse(fs.readFileSync(privateFile(args[0]), 'utf8'));
    if (!Array.isArray(input.actors) || input.actors.length !== 2 || !input.peer) fail('witness_schema');
    const observed = {};
    for (const actor of ['codex', 'claude']) {
      const fact = input.actors.find(row => row.actor === actor);
      const session = state.actors[actor];
      if (!fact || !session?.bindingId || fact.bindingId !== session.bindingId
        || fact.generation !== session.generation || !fact.operationId
        || !fact.challengeEventId || !fact.releaseId || !fact.replyEventId
        || !fact.challengeText || !fact.replyText || fact.ackObserved !== true) fail(`${actor}_witness_input`);
      const rows = nativeRows(session);
      const model = modelEvidence(rows, actor, fact.challengeText, fact.replyText, fact.replyEventId);
      if (!model.readCall || !model.visible || !model.sendCall) fail(`${actor}_model_read_ack_reply`);
      const other = input.actors.find(row => row.actor !== actor);
      if (!other || JSON.stringify(rows).includes(other.challengeText)) fail(`${actor}_cross_binding_read_leak`);
      observed[actor] = { actor, sessionId: session.sessionId, bindingId: session.bindingId,
        generation: session.generation, operationId: fact.operationId,
        challengeEventId: fact.challengeEventId, releaseId: fact.releaseId,
        modelReadEventId: fact.challengeEventId, observedReadEventIds: [fact.challengeEventId],
        readBindingId: session.bindingId, readGeneration: session.generation,
        ackReleaseId: fact.releaseId, ackBindingId: session.bindingId, ackGeneration: session.generation,
        replyEventId: fact.replyEventId, replyOrigin: 'model' };
    }
    const peer = input.peer;
    if (!['codex', 'claude'].includes(peer.from) || !['codex', 'claude'].includes(peer.to)
      || peer.from === peer.to || !peer.eventId || !peer.readEventId || !peer.replyEventId
      || peer.eventId !== peer.readEventId || !peer.messageText || !peer.replyText) fail('peer_input');
    const peerModel = modelEvidence(nativeRows(state.actors[peer.to]), peer.to,
      peer.messageText, peer.replyText, peer.replyEventId);
    if (!peerModel.readCall || !peerModel.visible || !peerModel.sendCall) fail('peer_model_exchange');
    state.native = [observed.codex, observed.claude];
    state.peer = { from: peer.from, to: peer.to, eventId: peer.eventId,
      readEventId: peer.readEventId, replyEventId: peer.replyEventId };
    save(directory, state);
    process.stdout.write(JSON.stringify({ kind: 'native_witness_observed', actors: ['codex', 'claude'] }) + '\n');
    return;
  }
  if (action === 'stop') {
    for (const actor of ['codex', 'claude']) {
      try { tmux(state, ['kill-session', '-t', actor]); } catch { /* already exited */ }
    }
    process.stdout.write(JSON.stringify({ kind: 'native_stopped' }) + '\n');
    return;
  }
  fail('unknown_action');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    const stage = /^external_native_[a-z_]+$/u.test(error?.message) ? error.message : 'external_native_unavailable';
    if (process.env.KHALA_E2E_CONSUMER_DIAGNOSTIC) {
      try { fs.writeFileSync(process.env.KHALA_E2E_CONSUMER_DIAGNOSTIC, JSON.stringify({ stage }) + '\n', { mode: 0o600 }); }
      catch { /* The caller still receives the redacted stage. */ }
    }
    process.stderr.write(JSON.stringify({ kind: 'failed', stage }) + '\n');
    process.exitCode = 1;
  }
}
