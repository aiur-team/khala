#!/usr/bin/env node
// Process-metadata observer. The live runner starts it as a separate
// unprivileged OS user (uid 65534, all capabilities dropped) sharing the host PID
// namespace, which is exactly the vantage point of another local account.
//
// Protocol: the first stdin line is the JSON config; the observer prints
// `{"ready":true}` after its first full sweep, keeps sweeping /proc until a
// second stdin line (or EOF) arrives, then prints one JSON report line. The
// config travels on stdin so the canary never appears in the observer's argv.

import { readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { containsLeak, redact } from './lib/canary.mjs';

const read = path => {
  try {
    return { ok: true, text: readFileSync(path, 'latin1') };
  } catch (error) {
    return { ok: false, code: error.code ?? 'ERROR' };
  }
};

const statusField = (status, key) => {
  const line = status.split('\n').find(l => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim().split(/\s+/)[0] : null;
};

export function createObserver(config) {
  const forms = config.forms;
  const exclude = new Set([process.pid, ...(config.excludePids ?? [])]);
  const opener = new RegExp(config.openerPattern);
  const browser = new RegExp(config.browserPattern);
  const markers = config.markers ?? [];
  const procs = new Map();
  const hits = new Map();
  const environ = {};
  const privateProbes = {};
  let sweeps = 0;

  const hit = (pid, field, text) => {
    const key = `${pid}:${field}`;
    if (!hits.has(key)) hits.set(key, { pid, field, sample: redact(text, forms).slice(0, 400) });
  };

  const inTree = pid => {
    for (let cur = pid, guard = 0; cur && guard < 64; guard++) {
      if (cur === config.launcherPid) return true;
      cur = procs.get(cur)?.ppid;
    }
    return false;
  };

  const tracked = pid => {
    const p = procs.get(pid);
    return inTree(pid) || (p && p.cmdlines.some(c => markers.some(m => c.includes(m))));
  };

  function sweep() {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (exclude.has(pid)) continue;
      const status = read(`/proc/${pid}/status`);
      if (!status.ok) continue;
      const cmd = read(`/proc/${pid}/cmdline`);
      const comm = read(`/proc/${pid}/comm`);
      const cmdline = cmd.ok ? cmd.text.replace(/\0+$/, '').split('\0').join(' ') : '';
      const commText = comm.ok ? comm.text.trim() : '';
      if (containsLeak(cmdline, forms)) hit(pid, 'cmdline', cmdline);
      if (containsLeak(commText, forms)) hit(pid, 'comm', commText);
      if (containsLeak(status.text, forms)) hit(pid, 'status', status.text);
      let p = procs.get(pid);
      if (!p) {
        p = {
          pid,
          uid: Number(statusField(status.text, 'Uid')),
          ppid: Number(statusField(status.text, 'PPid')),
          cmdlines: [],
        };
        procs.set(pid, p);
      }
      // Leak checks above use the full text; the report keeps a bounded excerpt.
      const shown = redact(cmdline || `[${commText}]`, forms).slice(0, 300);
      if (!p.cmdlines.includes(shown)) p.cmdlines.push(shown);
      if (!tracked(pid)) continue;
      const env = read(`/proc/${pid}/environ`);
      environ[env.ok ? 'readable' : env.code] = (environ[env.ok ? 'readable' : env.code] ?? 0) + 1;
      if (env.ok && containsLeak(env.text, forms)) hit(pid, 'environ', env.text);
      let tasks = [];
      try { tasks = readdirSync(`/proc/${pid}/task`); } catch {}
      for (const tid of tasks) {
        const t = read(`/proc/${pid}/task/${tid}/comm`);
        if (t.ok && containsLeak(t.text, forms)) hit(pid, `task/${tid}/comm`, t.text);
      }
    }
    for (const path of config.privatePaths ?? []) {
      let outcome;
      try {
        const text = readFileSync(path, 'latin1');
        outcome = 'readable';
        if (containsLeak(text, forms)) hit(0, `file:${path}`, text);
      } catch (error) {
        outcome = error.code === 'EISDIR' ? directoryProbe(path) : error.code;
      }
      privateProbes[path] ??= {};
      privateProbes[path][outcome] = (privateProbes[path][outcome] ?? 0) + 1;
    }
    sweeps++;
  }

  function directoryProbe(path) {
    try {
      readdirSync(path);
      return 'listable';
    } catch (error) {
      return error.code;
    }
  }

  function report() {
    const processes = [];
    for (const p of procs.values()) {
      if (!tracked(p.pid)) continue;
      const all = p.cmdlines.join('\n');
      const layer = p.pid === config.launcherPid ? 'launcher'
        : opener.test(all) ? 'opener'
          : browser.test(all) ? 'browser'
            : 'helper';
      processes.push({ ...p, layer });
    }
    const layers = { launcher: 0, opener: 0, browser: 0, helper: 0 };
    for (const p of processes) layers[p.layer]++;
    return {
      observerUid: process.getuid(),
      observerCapEff: statusField(readFileSync('/proc/self/status', 'latin1'), 'CapEff'),
      sweeps,
      scannedProcesses: procs.size,
      layers,
      processes,
      environ,
      privateProbes,
      hits: [...hits.values()],
    };
  }

  return { sweep, report };
}

async function main() {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const first = await lines.next();
  const observer = createObserver(JSON.parse(first.value));
  let stop = false;
  lines.next().then(() => { stop = true; });
  observer.sweep();
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  while (!stop) {
    observer.sweep();
    await new Promise(resolve => setImmediate(resolve));
  }
  observer.sweep();
  process.stdout.write(`${JSON.stringify(observer.report())}\n`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
