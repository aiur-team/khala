#!/usr/bin/env node
// Live proof runner. Runs repeated negative-control (`argv-url`) and selected
// (`private-file`) trials through the real xdg-open and a real browser, observed
// from uid 65534 in the host PID namespace, and writes redacted evidence.
//
//   node run.mjs --browser chromium --trials 5 --out evidence/linux-xdg-open-generic-chromium.json
//
// The browser is resolved by xdg-open from an isolated XDG config whose
// text/html and http(s) handler is a private desktop entry, so the run never
// touches the operator's own browser profile or default-handler settings.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OPENER_ENV, OPENER_ENV_REMOVED, captureProfile } from './lib/profile.mjs';
import { runTrial } from './lib/trial.mjs';
import { NEGATIVE_CONTROL, SELECTED, assess } from './verify.mjs';

export const BROWSERS = {
  chromium: {
    exec: dir => `/usr/bin/chromium --headless=new --user-data-dir=${dir} %U`,
    pattern: 'chromium',
  },
  firefox: {
    exec: dir => `/usr/bin/firefox --headless --no-remote --profile ${dir} %u`,
    pattern: 'firefox',
  },
};

const PROFILE_PLACEHOLDER = '<PRIVATE_BROWSER_PROFILE>';
const DESKTOP_ID = 'khala-proof-browser.desktop';

const { values } = parseArgs({
  options: {
    browser: { type: 'string', default: 'chromium' },
    trials: { type: 'string', default: '3' },
    image: { type: 'string', default: 'mcr.microsoft.com/playwright:v1.63.0-noble' },
    // Prove another invocation path, e.g. a headful one on a machine where a
    // window may appear: --exec '/usr/bin/chromium --user-data-dir={profile} %U'
    exec: { type: 'string' },
    out: { type: 'string' },
  },
});
const known = BROWSERS[values.browser];
if (!known) throw new Error(`unsupported browser: ${values.browser}`);
const browser = values.exec
  ? { ...known, exec: dir => values.exec.split('{profile}').join(dir) }
  : known;
if (values.exec && !values.exec.includes('{profile}')) {
  throw new Error('--exec must isolate the browser with a {profile} placeholder');
}

const root = await mkdtemp(join(tmpdir(), 'khala-browser-handoff-'));
// World-traversable on purpose: the only thing hiding the handoff file from the
// observer must be the handoff directory's own 0700 mode.
await chmod(root, 0o755);
const configHome = join(root, 'config');
const dataHome = join(root, 'data');
await mkdir(join(dataHome, 'applications'), { recursive: true });
await mkdir(configHome, { recursive: true });
await writeFile(join(configHome, 'mimeapps.list'), [
  '[Default Applications]',
  ...['text/html', 'x-scheme-handler/http', 'x-scheme-handler/https'].map(m => `${m}=${DESKTOP_ID}`),
  '',
].join('\n'));

// Chromium places its singleton socket under TMPDIR and aborts when that path
// exceeds sun_path; it creates a uniquely named directory there, so the shared
// system temp directory is safe to use.
const env = { ...process.env, TMPDIR: '/tmp', XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, ...OPENER_ENV };
for (const key of OPENER_ENV_REMOVED) delete env[key];

async function useBrowserProfile(n) {
  const dir = join(root, `browser-profile-${n}`);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dataHome, 'applications', DESKTOP_ID), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Khala proof browser',
    `Exec=${browser.exec(dir)}`,
    'MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;',
    '',
  ].join('\n'));
  return dir;
}

const trials = [];
let profile;
try {
  const count = Number(values.trials);
  for (let i = 0; i < count; i++) {
    for (const strategy of [NEGATIVE_CONTROL, SELECTED]) {
      const dir = await useBrowserProfile(`${i}-${strategy}`);
      profile ??= captureProfile({ env, handoff: SELECTED, normalize: s => s.split(dir).join(PROFILE_PLACEHOLDER) });
      const trial = await runTrial({
        strategy,
        opener: { command: 'xdg-open', args: [], env },
        observer: { kind: 'docker', image: values.image, mounts: [root] },
        handoffParent: root,
        openerPattern: 'xdg-open',
        browserPattern: browser.pattern,
        markers: [dir],
      });
      process.stderr.write(`${strategy}[${i}]: delivered=${trial.delivered} leak=${trial.leak} layers=${JSON.stringify(trial.observer.layers)}\n`);
      trials.push(trial);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

const evidence = {
  harness: 'browser-handoff-spike',
  generatedAt: new Date().toISOString(),
  targetUid: process.getuid(),
  observer: {
    kind: 'docker',
    image: values.image,
    flags: '--pid=host --network=none --user=65534:65534 --cap-drop=ALL --security-opt=no-new-privileges',
  },
  profile,
  trials,
};
const redacted = JSON.parse(JSON.stringify(evidence)
  .split(root).join('<TRIAL_ROOT>')
  .split(homedir()).join('$HOME'));
const verdict = assess(redacted);
const text = `${JSON.stringify({ ...redacted, verdict }, null, 2)}\n`;
if (values.out) await writeFile(resolve(values.out), text);
else process.stdout.write(text);
process.stderr.write(`${JSON.stringify(verdict)}\n`);
process.exit(verdict.proved ? 0 : 1);
