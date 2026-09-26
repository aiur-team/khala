import { type ChildProcess, execFile, spawn as childSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Automatic browser opening, ported from the browser-handoff spike. The printed
// manual URL is always the primary path; this adapter only ever adds to it.
//
// - It opens only on an exact match with a proven environment profile.
// - The credential-bearing URL goes into a 0600 file inside a fresh 0700
//   directory, and the opener receives only that file's absolute path. The URL
//   never reaches any process argv or environment, where another user could
//   read it from /proc/<pid>/cmdline.
// - It never throws: every failure, including preparing the private file, is a
//   normal `opened: false` outcome.

export const OPENER_COMMAND = 'xdg-open';

// Forcing X-Generic makes xdg-open take its generic mime path instead of
// probing the session for a desktop-specific opener (gio, kde-open, ...).
export const OPENER_ENV: Readonly<Record<string, string>> = Object.freeze({ XDG_CURRENT_DESKTOP: 'X-Generic' });
export const OPENER_ENV_REMOVED: readonly string[] = Object.freeze(['BROWSER']);

/** Fields a runtime profile must match exactly; everything else is evidence only. */
export const MATCH_FIELDS = Object.freeze([
  'os', 'procfsHidepid', 'opener.implementation', 'opener.version', 'opener.mode', 'opener.display',
  'handler.mimeType', 'handler.exec', 'browser.name', 'browser.major', 'handoff',
] as const);

export type EnvironmentProfile = Readonly<{
  os?: string | undefined;
  procfsHidepid?: string | undefined;
  opener?: Readonly<{ implementation?: string | undefined; version?: string | undefined; mode?: string | undefined; display?: string | undefined }>;
  handler?: Readonly<{ mimeType?: string | undefined; exec?: string | undefined }>;
  browser?: Readonly<{ name?: string | undefined; major?: string | undefined }>;
  handoff?: string | undefined;
}>;

export type ProvenProfile = Readonly<{ id: string; profile: EnvironmentProfile }>;

/**
 * Profiles with cross-user process evidence (experiments/.../browser-handoff).
 * Every other environment prints the manual URL only.
 */
export const PROVEN_PROFILES: readonly ProvenProfile[] = Object.freeze([
  {
    id: 'linux-xdg-open-generic-chromium150-headless',
    profile: {
      os: 'linux', procfsHidepid: 'off',
      opener: { implementation: 'xdg-utils xdg-open', version: '1.2.1', mode: 'generic', display: 'present' },
      handler: { mimeType: 'text/html', exec: '/usr/bin/chromium --headless=new --user-data-dir=<PRIVATE_BROWSER_PROFILE> %U' },
      browser: { name: 'chromium', major: '150' },
      handoff: 'private-file',
    },
  },
  {
    id: 'linux-xdg-open-generic-firefox152-headless',
    profile: {
      os: 'linux', procfsHidepid: 'off',
      opener: { implementation: 'xdg-utils xdg-open', version: '1.2.1', mode: 'generic', display: 'present' },
      handler: { mimeType: 'text/html', exec: '/usr/bin/firefox --headless --no-remote --profile <PRIVATE_BROWSER_PROFILE> %u' },
      browser: { name: 'firefox', major: '152' },
      handoff: 'private-file',
    },
  },
]);

export type OpenOutcome =
  | Readonly<{ opened: true; profileId: string; cleanup(): Promise<void> }>
  | Readonly<{ opened: false; reason: string }>;

type Spawn = (command: string, args: readonly string[], options: Readonly<{
  env: Record<string, string>; detached: boolean; stdio: 'ignore';
}>) => ChildProcess;

export type OpenBootstrapInput = Readonly<{
  bootstrapUrl: string;
  /** The one-time credential inside `bootstrapUrl`; used only by the leak guard. */
  credential: string;
  /** Private parent for the per-launch handoff directory. */
  handoffParent: string;
  env: Readonly<Record<string, string | undefined>>;
  profiles?: readonly ProvenProfile[];
  capture?: (env: Readonly<Record<string, string>>) => EnvironmentProfile | null | Promise<EnvironmentProfile | null>;
  spawn?: Spawn;
}>;

const field = (profile: EnvironmentProfile, name: string): unknown =>
  name.split('.').reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), profile);

export function automaticOpenDecision(
  runtime: EnvironmentProfile | null,
  profiles: readonly ProvenProfile[],
): Readonly<{ open: true; profileId: string }> | Readonly<{ open: false; reason: string }> {
  if (!runtime) return { open: false, reason: 'runtime profile not established' };
  const missing = MATCH_FIELDS.filter(name => field(runtime, name) == null || field(runtime, name) === '');
  if (missing.length) return { open: false, reason: `runtime profile not established: ${missing.join(', ')}` };
  for (const proven of profiles) {
    if (MATCH_FIELDS.every(name => field(runtime, name) === field(proven.profile, name))) return { open: true, profileId: proven.id };
  }
  return { open: false, reason: 'environment differs from every proven profile' };
}

/** Every form the credential could take in process metadata. */
export function leakForms(credential: string): string[] {
  const forms = new Set([credential, encodeURIComponent(credential)]);
  // Base64 of a longer string encodes the secret differently at each byte
  // alignment, so each alignment contributes its stable middle section.
  for (let offset = 0; offset < 3; offset++) {
    const bytes = Buffer.concat([Buffer.alloc(offset), Buffer.from(credential)]);
    for (const encoding of ['base64', 'base64url'] as const) {
      const text = bytes.toString(encoding).replace(/=+$/, '');
      forms.add(text.slice(offset === 0 ? 0 : 4, text.length - 4));
    }
  }
  return [...forms].filter(form => form.length > 0);
}

export function containsLeak(text: string, forms: readonly string[]): boolean {
  return forms.some(form => text.includes(form));
}

export function handoffDocument(url: string): Buffer {
  // `<` is escaped so the URL can never close the script element.
  const literal = JSON.stringify(url).replace(/</g, '\\u003c');
  return Buffer.from([
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Khala</title>',
    `<script>location.replace(${literal});</script>`,
    '</head>',
    '<body></body>',
    '</html>',
    '',
  ].join('\n'), 'utf8');
}

type PreparedHandoff = Readonly<{ argv: readonly string[]; cleanup(): Promise<void> }>;

async function prepareHandoff(url: string, parent: string): Promise<PreparedHandoff> {
  const directory = await fs.promises.mkdtemp(path.join(parent, 'handoff-'));
  const cleanup = () => fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  try {
    await fs.promises.chmod(directory, 0o700);
    const file = path.join(directory, 'open.html');
    await fs.promises.writeFile(file, handoffDocument(url), { mode: 0o600, flag: 'wx' });
    return { argv: [file], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Asynchronous so profiling never blocks the running server or signal handling. */
function run(file: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(file, [...args], { env, encoding: 'utf8', timeout: 5_000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
    } catch {
      resolve(undefined);
    }
  });
}

function procfsHidepid(mounts: string): string | undefined {
  const line = mounts.split('\n').find(entry => entry.split(' ')[1] === '/proc' && entry.split(' ')[2] === 'proc');
  if (!line) return undefined;
  const option = (line.split(' ')[3] ?? '').split(',').find(value => value.startsWith('hidepid='));
  return option ? option.slice('hidepid='.length) : 'off';
}

function desktopExec(desktopId: string, env: Readonly<Record<string, string>>): string | undefined {
  // Relative entries would let the working directory choose the profiled binary.
  const directories = [
    env.XDG_DATA_HOME || (env.HOME ? path.join(env.HOME, '.local/share') : ''),
    ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'),
  ].filter(directory => path.isAbsolute(directory));
  for (const directory of directories) {
    try {
      const text = fs.readFileSync(path.join(directory, 'applications', desktopId), 'utf8');
      const entry = text.split('[Desktop Entry]')[1]?.split(/^\[/m)[0] ?? '';
      const exec = entry.split('\n').find(line => line.startsWith('Exec='));
      if (exec) return exec.slice('Exec='.length).trim();
    } catch {}
  }
  return undefined;
}

/** Captures the profile from the exact environment the opener would receive. */
export async function captureProfile(env: Readonly<Record<string, string>>): Promise<EnvironmentProfile> {
  const versionLine = await run(OPENER_COMMAND, ['--version'], env);
  const desktopId = await run('xdg-mime', ['query', 'default', 'text/html'], env);
  const exec = desktopId ? desktopExec(desktopId, env) : undefined;
  const program = exec?.split(/\s+/)[0];
  const browserVersion = program && path.isAbsolute(program) ? await run(program, ['--version'], env) : undefined;
  let mounts = '';
  try { mounts = fs.readFileSync('/proc/mounts', 'utf8'); } catch {}
  return {
    os: process.platform,
    procfsHidepid: procfsHidepid(mounts),
    opener: {
      implementation: versionLine?.startsWith('xdg-open ') ? 'xdg-utils xdg-open' : undefined,
      version: versionLine?.split(' ')[1],
      mode: env.XDG_CURRENT_DESKTOP === 'X-Generic' ? 'generic' : undefined,
      display: env.DISPLAY || env.WAYLAND_DISPLAY ? 'present' : 'absent',
    },
    handler: { mimeType: 'text/html', exec },
    browser: { name: browserVersion?.match(/chromium|firefox/i)?.[0].toLowerCase(), major: browserVersion?.match(/(\d+)\./)?.[1] },
    handoff: 'private-file',
  };
}

function openerEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') result[key] = value;
  Object.assign(result, OPENER_ENV);
  for (const key of OPENER_ENV_REMOVED) delete result[key];
  return result;
}

async function attempt(input: OpenBootstrapInput): Promise<OpenOutcome> {
  const env = openerEnvironment(input.env);
  // A credential already present in the inherited environment would reach the opener.
  const forms = leakForms(input.credential);
  let runtime: EnvironmentProfile | null = null;
  try { runtime = await (input.capture ?? captureProfile)(env); } catch {}
  const decision = automaticOpenDecision(runtime, input.profiles ?? PROVEN_PROFILES);
  if (!decision.open) return { opened: false, reason: decision.reason };

  let handoff: PreparedHandoff;
  try {
    handoff = await prepareHandoff(input.bootstrapUrl, input.handoffParent);
  } catch {
    return { opened: false, reason: 'private handoff file could not be prepared' };
  }
  if (containsLeak(JSON.stringify([handoff.argv, env]), forms)) {
    await handoff.cleanup();
    return { opened: false, reason: 'credential would reach opener argv or environment' };
  }
  const spawn: Spawn = input.spawn ?? ((command, args, options) => childSpawn(command, [...args], options));
  const started = await new Promise<string | null>(resolve => {
    try {
      const child = spawn(OPENER_COMMAND, handoff.argv, { env, detached: true, stdio: 'ignore' });
      child.once('spawn', () => { child.unref(); resolve(null); });
      child.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'spawn failed'));
    } catch (error) {
      resolve((error as NodeJS.ErrnoException).code ?? 'spawn failed');
    }
  });
  if (started !== null) {
    await handoff.cleanup();
    return { opened: false, reason: `opener did not start: ${started}` };
  }
  return { opened: true, profileId: decision.profileId, cleanup: handoff.cleanup };
}

/** Never throws and never delays launch on failure; the caller always prints the URL. */
export async function openBootstrap(input: OpenBootstrapInput): Promise<OpenOutcome> {
  try {
    return await attempt(input);
  } catch {
    return { opened: false, reason: 'automatic opening failed' };
  }
}
