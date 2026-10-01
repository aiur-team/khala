import { spawn, execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIAGNOSTIC_COMPONENTS = new Set(['hosted_session', 'hosted_open', 'subscription', 'native_ready', 'activation']);
const REQUEST_PHASES = new Set(['restart_activation', 'pre_owner_route', 'pre_owner_read',
  'owner_guard', 'post_owner_activation', 'other']);
const REQUEST_TOOLS = new Set(['khala_channel_access_status', 'khala_status', 'khala_read', 'khala_send']);
const STORAGE_CODES = new Set(['unsafe_path', 'missing_state', 'locked', 'corrupt', 'schema_unsupported',
  'storage_full', 'limit_exceeded', 'io_failed', 'closed', 'fenced', 'identity_mismatch',
  'payload_unavailable', 'revoked', 'invalid_input', 'transaction_aborted',
  'async_transaction', 'nested_transaction']);
function typedDiagnostics(output) {
  return output.trim().split('\n').filter(Boolean).flatMap(line => {
    try {
      const { component, stage, result, errorCode } = JSON.parse(line);
      return DIAGNOSTIC_COMPONENTS.has(component) && typeof stage === 'string' && typeof result === 'string'
        ? [{ component, stage, result, ...(STORAGE_CODES.has(errorCode) ? { errorCode } : {}) }] : [];
    } catch { return []; }
  }).slice(-20);
}

/** Stock package, private HOME/state and a stable native label; no inherited credentials. */
export function installRecoveryClient({ tarball, origin, caFile, sessionId, workdir, chromiumExecutable,
  fixtureBrowser = false, fixtureBrowserCertificateFile, harness = 'claude', pinnedClaudeProbe = false }) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== origin
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)
    || !['claude', 'codex'].includes(harness)) throw new Error('invalid_recovery_fixture');
  const root = mkdtempSync(path.join(os.tmpdir(), 'khala-installed-recovery-'));
  chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const prefix = path.join(root, 'installed');
  const bin = path.join(root, 'bin');
  for (const directory of [home, state, prefix, bin]) mkdirSync(directory, { mode: 0o700 });
  if (fixtureBrowser) {
    // The external browser command crosses a real process boundary. It delivers
    // only the URL to the fixture control route; owner cookies stay server-side.
    writeFileSync(path.join(bin, 'xdg-open'), `#!/usr/bin/env node
const origin = ${JSON.stringify(origin)};
const target = new URL(process.argv[2]);
if (target.origin !== origin || target.protocol !== 'https:') process.exit(1);
const response = await fetch(origin + '/__fixture/browser-open', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: target.href }), redirect: 'manual',
});
if (response.status !== 204) process.exit(1);
`, { mode: 0o700 });
  }
  if (pinnedClaudeProbe) {
    // The fixture asserts only an owner-approved proof-key label. This probe
    // does not assert that a provider session exists on the host.
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "2.1.284 (Claude Code)\\n"\n',
      { mode: 0o700 });
  }
  if (harness === 'codex') {
    // Fixture-only version probe; the owner-approved key remains the hosted
    // authority. This does not prove a real provider thread exists.
    writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "codex-cli 0.157.1\\n"\n',
      { mode: 0o700 });
  }
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    CODEX_HOME: path.join(home, 'codex'), KHALA_APP_ORIGIN: origin, NODE_EXTRA_CA_CERTS: caFile,
    ...(harness === 'claude' ? { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId } : {}) };
  const withSessionMeta = message => harness === 'codex' && message.method === 'tools/call'
    ? { ...message, params: { ...message.params,
      _meta: Object.hasOwn(message.params, '_meta') ? message.params._meta : { threadId: sessionId } } } : message;
  try {
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--prefix', prefix, path.resolve(tarball)], { env, stdio: 'ignore', timeout: 30_000 });
    // Provision the real browser at the stock CLI's supported runtime path.
    // CI installs Playwright Chromium outside system browser locations.
    if (chromiumExecutable !== undefined) {
      if (!path.isAbsolute(chromiumExecutable) || !statSync(chromiumExecutable).isFile()
        || path.basename(chromiumExecutable) !== 'chrome') throw new Error('fixture_browser_invalid');
      const browserRoot = path.join(prefix, 'node_modules', '@aiur', 'khala', 'dist', 'chromium');
      mkdirSync(browserRoot, { mode: 0o700 });
      if (fixtureBrowserCertificateFile) {
        if (!fixtureBrowser) throw new Error('fixture_browser_invalid');
        // Chromium does not use NODE_EXTRA_CA_CERTS. Permit only the exact
        // disposable server certificate in this fixture's installed browser.
        const cert = new X509Certificate(readFileSync(fixtureBrowserCertificateFile));
        const spki = cert.publicKey.export({ format: 'der', type: 'spki' });
        const pin = createHash('sha256').update(spki).digest('base64');
        const browserBin = path.join(browserRoot, 'chrome-linux64');
        mkdirSync(browserBin, { mode: 0o700 });
        const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(path.join(browserBin, 'chrome'),
          `#!/bin/sh\nexec ${shellQuote(chromiumExecutable)} --ignore-certificate-errors-spki-list=${shellQuote(pin)} "$@"\n`,
          { mode: 0o700 });
      } else {
        symlinkSync(path.dirname(chromiumExecutable), path.join(browserRoot, 'chrome-linux64'));
      }
    }
  } catch {
    rmSync(root, { recursive: true, force: true });
    throw new Error('fixture_package_install_failed');
  }
  const launcher = path.join(prefix, 'node_modules', '.bin', 'khala');
  const processes = new Set();
  return {
    stateDirectory: state,
    browserExecutable: chromiumExecutable === undefined ? null
      : path.join(prefix, 'node_modules', '@aiur', 'khala', 'dist', 'chromium', 'chrome-linux64', 'chrome'),
    /** Replies stay private. Callers must emit only whitelisted typed receipt fields. */
    call(messages, { terminateOn } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [launcher, 'mcp-serve'], { cwd: workdir, env,
          stdio: ['pipe', 'pipe', 'pipe'] });
        processes.add(child);
        let interrupted = false;
        if (terminateOn) void Promise.resolve(terminateOn).then(() => {
          if (processes.has(child)) { interrupted = true; child.kill('SIGKILL'); }
        });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
        let output = ''; let diagnostics = ''; let tooLarge = false;
        child.stdout.on('data', chunk => {
          output += chunk;
          if (Buffer.byteLength(output) > 65_536) { tooLarge = true; child.kill('SIGKILL'); }
        });
        // Retain only the CLI's typed operational diagnostics. Raw stderr may
        // contain private request data, so it is never returned to the test.
        child.stderr.on('data', chunk => {
          diagnostics += chunk;
          if (Buffer.byteLength(diagnostics) > 16_384) {
            diagnostics = ''; child.kill('SIGKILL');
          }
        });
        child.stdin.on('error', () => {});
        child.once('error', () => { clearTimeout(timer); processes.delete(child); reject(new Error('fixture_client_start_failed')); });
        child.once('close', code => {
          clearTimeout(timer); processes.delete(child);
          if (interrupted) { resolve({ pid: child.pid, replies: [], diagnostics: [], terminated: true }); return; }
          if (code !== 0 || tooLarge) {
            const stages = diagnostics.trim().split('\n').filter(Boolean).flatMap(line => {
              try {
                const { component, stage, result } = JSON.parse(line);
                return ['hosted_open', 'subscription', 'native_ready', 'activation'].includes(component)
                  && typeof stage === 'string' && typeof result === 'string'
                  ? [`${component}/${stage}/${result}`] : [];
              } catch { return []; }
            }).slice(-8);
            reject(new Error(`fixture_client_failed:${timedOut ? 'timeout' : 'exit'}:${stages.join(',')}`));
            return;
          }
          try {
            const events = typedDiagnostics(diagnostics);
            resolve({ pid: child.pid, replies: output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), diagnostics: events });
          }
          catch { reject(new Error('fixture_client_invalid_reply')); }
        });
        child.stdin.end(messages.map(message => JSON.stringify(withSessionMeta(message)) + '\n').join(''));
      });
    },
    /** Keep the installed MCP process alive while owner review and native tools run. */
    session() {
      const child = spawn(process.execPath, [launcher, 'mcp-serve'], { cwd: workdir, env,
        stdio: ['pipe', 'pipe', 'pipe'] });
      processes.add(child);
      let output = ''; let diagnostics = ''; let closed = false;
      const pending = new Map();
      const fail = () => {
        closed = true;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('fixture_client_failed')); }
        pending.clear();
      };
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > 65_536) { child.kill('SIGKILL'); return; }
        for (;;) {
          const index = output.indexOf('\n');
          if (index < 0) break;
          const line = output.slice(0, index); output = output.slice(index + 1);
          let reply;
          try { reply = JSON.parse(line); } catch { child.kill('SIGKILL'); return; }
          const item = pending.get(reply.id);
          if (item) { pending.delete(reply.id); clearTimeout(item.timer); item.resolve(reply); }
        }
      });
      child.stderr.on('data', chunk => {
        diagnostics += chunk;
        if (Buffer.byteLength(diagnostics) > 16_384) { diagnostics = ''; child.kill('SIGKILL'); }
      });
      child.stdin.on('error', () => {});
      child.once('error', fail);
      child.once('close', () => { processes.delete(child); fail(); });
      return {
        pid: child.pid,
        request(message, phase = 'other') {
          if (closed || pending.has(message.id)) return Promise.reject(new Error('fixture_client_unavailable'));
          return new Promise((resolve, reject) => {
            // A status call may start the browser SDK and its bounded 30s
            // initial sync. Let it return its typed activation outcome first.
            const tool = REQUEST_TOOLS.has(message.params?.name) ? message.params.name : 'other';
            const timeoutMs = tool === 'khala_channel_access_status' ? 40_000 : 15_000;
            const timer = setTimeout(() => {
              const stages = typedDiagnostics(diagnostics).slice(-5).map(({ component, stage, result }) => ({ component, stage, result }));
              const snapshot = { phase: REQUEST_PHASES.has(phase) ? phase : 'other', tool,
                process: closed ? 'closed' : 'alive', pending: pending.size, stages };
              pending.delete(message.id);
              reject(new Error(`fixture_client_timeout:${JSON.stringify(snapshot)}`));
              child.kill('SIGKILL');
            }, timeoutMs);
            pending.set(message.id, { resolve, reject, timer });
            child.stdin.write(JSON.stringify(withSessionMeta(message)) + '\n');
          });
        },
        diagnostics() {
          return typedDiagnostics(diagnostics);
        },
        async close() {
          if (!closed) child.stdin.end();
          if (processes.has(child)) await new Promise(resolve => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
            child.once('close', () => { clearTimeout(timer); resolve(); });
          });
        },
      };
    },
    close() {
      if (processes.size > 0) throw new Error('fixture_client_still_running');
      rmSync(root, { recursive: true, force: true });
    },
  };
}
