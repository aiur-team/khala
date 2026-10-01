import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Stock package, private HOME/state and a stable native label; no inherited credentials. */
export function installRecoveryClient({ tarball, origin, caFile, sessionId, workdir, chromiumExecutable,
  fixtureBrowser = false, pinnedClaudeProbe = false }) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== origin
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new Error('invalid_recovery_fixture');
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
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    CODEX_HOME: path.join(home, 'codex'), KHALA_APP_ORIGIN: origin,
    KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId, NODE_EXTRA_CA_CERTS: caFile };
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
      symlinkSync(path.dirname(chromiumExecutable), path.join(browserRoot, 'chrome-linux64'));
    }
  } catch {
    rmSync(root, { recursive: true, force: true });
    throw new Error('fixture_package_install_failed');
  }
  const launcher = path.join(prefix, 'node_modules', '.bin', 'khala');
  const processes = new Set();
  return {
    stateDirectory: state,
    /** Replies stay private. Callers must emit only whitelisted typed receipt fields. */
    call(messages) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [launcher, 'mcp-serve'], { cwd: workdir, env,
          stdio: ['pipe', 'pipe', 'pipe'] });
        processes.add(child);
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
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
          if (code !== 0 || tooLarge) { reject(new Error('fixture_client_failed')); return; }
          try {
            const events = diagnostics.trim().split('\n').filter(Boolean).flatMap(line => {
              try {
                const value = JSON.parse(line);
                return value?.component === 'hosted_session' && value.stage === 'open'
                  && value.result === 'unavailable' ? [{ component: 'hosted_session', stage: 'open', result: 'unavailable' }] : [];
              } catch { return []; }
            });
            resolve({ pid: child.pid, replies: output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), diagnostics: events });
          }
          catch { reject(new Error('fixture_client_invalid_reply')); }
        });
        child.stdin.end(messages.map(message => JSON.stringify(message) + '\n').join(''));
      });
    },
    close() {
      if (processes.size > 0) throw new Error('fixture_client_still_running');
      rmSync(root, { recursive: true, force: true });
    },
  };
}
