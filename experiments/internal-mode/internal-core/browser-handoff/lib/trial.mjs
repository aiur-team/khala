// One handoff trial: a fake loopback bootstrap server, a cross-user (or, in
// unit tests, local) observer sweeping /proc, and the launcher spawning the
// opener with the strategy's argv. The launcher is the process running this
// module; the opener and the browser it starts are its descendants.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { bootstrapUrl, containsLeak, createCanary, leakForms, redact } from './canary.mjs';
import { prepareHandoff } from './strategies.mjs';

export const OBSERVER = fileURLToPath(new URL('../observer.mjs', import.meta.url));
export const HARNESS_DIR = fileURLToPath(new URL('..', import.meta.url));

const BOOTSTRAP_DOCUMENT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Khala</title>
<script>
const f = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
fetch('/__khala/session', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ credential: f.get('credential'), channelId: f.get('channel') }) });
</script></head><body></body></html>
`;

// Mirrors the authenticated-loopback-server bootstrap shape: the credential
// arrives only in the fragment and is exchanged by a same-origin POST.
export function startFakeServer({ canary, channelId }) {
  let deliver;
  const delivered = new Promise(resolve => { deliver = resolve; });
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__khala/bootstrap') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(BOOTSTRAP_DOCUMENT);
      return;
    }
    if (req.method === 'POST' && req.url === '/__khala/session') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let ok = false;
        try {
          const parsed = JSON.parse(body);
          ok = parsed.credential === canary && parsed.channelId === channelId;
        } catch {}
        if (ok) deliver(true);
        res.writeHead(ok ? 200 : 401).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        delivered,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

export function observerCommand({ kind, image, mounts = [] }) {
  if (kind === 'local') return [process.execPath, [OBSERVER]];
  if (kind === 'docker') {
    return ['docker', [
      'run', '-i', '--rm',
      '--pid=host', '--network=none',
      '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      `--volume=${HARNESS_DIR}:/harness:ro`,
      ...mounts.map(m => `--volume=${m}:${m}:ro`),
      image, 'node', '/harness/observer.mjs',
    ]];
  }
  throw new Error(`unknown observer kind: ${kind}`);
}

function startObserver(spec, config) {
  const [command, args] = observerCommand(spec);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(`${JSON.stringify({ ...config, excludePids: [child.pid] })}\n`);
  return {
    ready: lines.next().then(({ value }) => {
      if (!value || !JSON.parse(value).ready) throw new Error('observer did not become ready');
    }),
    async stop() {
      child.stdin.end('stop\n');
      const { value } = await lines.next();
      if (!value) throw new Error('observer exited without a report');
      return JSON.parse(value);
    },
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function killTree(child, markers) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  for (const marker of markers) spawn('pkill', ['-TERM', '-f', marker], { stdio: 'ignore' });
  return sleep(500).then(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const marker of markers) spawn('pkill', ['-KILL', '-f', marker], { stdio: 'ignore' });
  });
}

// Runs one trial and returns a redacted record. `opener` is `{ command, args,
// env }`; the strategy's argv is appended to `args`.
export async function runTrial({
  strategy,
  opener,
  observer,
  handoffParent,
  openerPattern,
  browserPattern,
  markers = [],
  // A same-user observer can always read the launcher's own files, so private
  // path probes only mean something from a separate OS user.
  probePrivatePaths = true,
  timeoutMs = 20_000,
  settleMs = 1_500,
}) {
  const canary = createCanary();
  const forms = leakForms(canary);
  const channelId = `channel-${Date.now().toString(36)}`;
  const server = await startFakeServer({ canary, channelId });
  const url = bootstrapUrl({ origin: server.origin, canary, channelId });
  const handoff = await prepareHandoff(strategy, { url, parentDir: handoffParent });
  const openerArgs = [...(opener.args ?? []), ...handoff.argv];
  const launcherEnvLeak = containsLeak(JSON.stringify(opener.env ?? {}), forms);

  const watch = startObserver(observer, {
    forms,
    launcherPid: process.pid,
    openerPattern,
    browserPattern,
    markers,
    privatePaths: probePrivatePaths ? handoff.privatePaths : [],
  });
  await watch.ready;

  const child = spawn(opener.command, openerArgs, { env: opener.env, detached: true, stdio: 'ignore' });
  const started = Date.now();
  let timer;
  const delivered = await Promise.race([
    server.delivered,
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, false); }),
  ]);
  clearTimeout(timer);
  const deliveryMs = delivered ? Date.now() - started : null;
  await handoff.cleanup();
  await sleep(settleMs);
  await killTree(child, markers);
  const report = await watch.stop();
  await server.close();

  return {
    strategy,
    openerArgv: [opener.command, ...openerArgs].map(a => redact(a, forms)),
    launcherEnvLeak,
    delivered,
    deliveryMs,
    leak: report.hits.length > 0 || launcherEnvLeak,
    observer: report,
  };
}
