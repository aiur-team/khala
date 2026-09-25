// Environment profiles. A profile names every input that decides whether
// process metadata can expose the handoff: OS and procfs visibility, the opener
// implementation and the mode it runs in, the exact browser invocation that
// opener resolves to, and the handoff strategy. Automatic opening is allowed
// only when the runtime profile is fully established and matches a proven one.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';

// Forcing X-Generic makes xdg-open take its generic mime path instead of
// probing the session for a desktop-specific opener (gio, kde-open, ...).
export const OPENER_ENV = Object.freeze({ XDG_CURRENT_DESKTOP: 'X-Generic' });
export const OPENER_ENV_REMOVED = Object.freeze(['BROWSER']);

// The fields a runtime profile must match exactly. Anything else in a profile
// (kernel build, observer image) is recorded evidence, not a match input.
export const MATCH_FIELDS = Object.freeze([
  'os',
  'procfsHidepid',
  'opener.implementation',
  'opener.version',
  'opener.mode',
  'handler.mimeType',
  'handler.exec',
  'browser.name',
  'browser.major',
  'handoff',
]);

const get = (object, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), object);

export function procfsHidepid(mounts) {
  const line = mounts.split('\n').find(l => l.split(' ')[1] === '/proc' && l.split(' ')[2] === 'proc');
  if (!line) return undefined;
  const option = line.split(' ')[3].split(',').find(o => o.startsWith('hidepid='));
  return option ? option.slice('hidepid='.length) : 'off';
}

function desktopExec(desktopId, env) {
  const dirs = [
    env.XDG_DATA_HOME ?? join(env.HOME ?? '', '.local/share'),
    ...(env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':'),
  ];
  for (const dir of dirs) {
    try {
      const text = readFileSync(join(dir, 'applications', desktopId), 'utf8');
      const entry = text.split('[Desktop Entry]')[1]?.split(/^\[/m)[0] ?? '';
      const exec = entry.split('\n').find(l => l.startsWith('Exec='));
      if (exec) return exec.slice('Exec='.length).trim();
    } catch {}
  }
  return undefined;
}

const run = (file, args, env) => {
  try {
    return execFileSync(file, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

// `normalize` rewrites run-specific paths (a private browser profile directory)
// into stable placeholders so two runs of the same profile compare equal.
export function captureProfile({ env, handoff, mimeType = 'text/html', normalize = s => s }) {
  const openerEnv = { ...env, ...OPENER_ENV };
  for (const key of OPENER_ENV_REMOVED) delete openerEnv[key];
  const osRelease = run('cat', ['/etc/os-release'], env) ?? '';
  const versionLine = run('xdg-open', ['--version'], openerEnv);
  const desktopId = run('xdg-mime', ['query', 'default', mimeType], openerEnv);
  const exec = desktopId ? desktopExec(desktopId, openerEnv) : undefined;
  const program = exec?.split(/\s+/)[0];
  const browserVersion = program ? run(program, ['--version'], openerEnv) : undefined;
  const name = browserVersion?.match(/chromium|firefox/i)?.[0].toLowerCase();
  return {
    os: process.platform,
    distro: osRelease.match(/^ID=(.*)$/m)?.[1],
    kernel: release(),
    procfsHidepid: procfsHidepid(readFileSync('/proc/mounts', 'utf8')),
    ptraceScope: run('cat', ['/proc/sys/kernel/yama/ptrace_scope'], env),
    opener: {
      implementation: versionLine?.startsWith('xdg-open ') ? 'xdg-utils xdg-open' : undefined,
      version: versionLine?.split(' ')[1],
      mode: openerEnv.XDG_CURRENT_DESKTOP === 'X-Generic' ? 'generic' : undefined,
    },
    handler: { mimeType, desktopId, exec: exec && normalize(exec) },
    browser: { name, version: browserVersion, major: browserVersion?.match(/(\d+)\./)?.[1] },
    handoff,
  };
}

export function profileMismatch(runtime, proven) {
  const missing = MATCH_FIELDS.filter(f => get(runtime, f) == null || get(runtime, f) === '');
  if (missing.length) return `runtime profile not established: ${missing.join(', ')}`;
  const differs = MATCH_FIELDS.filter(f => get(runtime, f) !== get(proven, f));
  return differs.length ? `differs from proof: ${differs.join(', ')}` : null;
}

// Decide automatic browser opening. Every non-match returns `open: false`; the
// caller then prints the manual local URL and continues the launch.
export function automaticOpenDecision(runtime, matrix) {
  if (!runtime) return { open: false, reason: 'runtime profile not established' };
  const reasons = [];
  for (const entry of matrix.filter(e => e.status === 'proven')) {
    const mismatch = profileMismatch(runtime, entry.profile);
    if (mismatch === null) return { open: true, profileId: entry.id };
    reasons.push(`${entry.id}: ${mismatch}`);
  }
  return { open: false, reason: reasons.join('; ') || 'no proven profile' };
}
