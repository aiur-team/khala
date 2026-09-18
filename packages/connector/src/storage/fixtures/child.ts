// Runs a script body in a separate Node process with the storage modules in scope, for
// crash, lock and umask tests that need a real process boundary.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const storageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.resolve(storageDir, '../..');

export type Child = { process: ChildProcessWithoutNullStreams; line: Promise<unknown>; exited: Promise<unknown> };

/**
 * Runs `body` with `open`, `fx` (fixtures), `limits`, `dir` and `signal(value)` in
 * scope. `signal` prints one JSON line to the parent immediately, so a test can kill
 * the child while `body` is still running. Otherwise the child prints its result as one
 * JSON line, then keeps its store open (and its lock held) until it is killed.
 */
export function spawnChild(dir: string, body: string): Child {
  const script = `
    import fs from 'node:fs';
    import { openConnectorStorage as open } from ${JSON.stringify(path.join(storageDir, 'open.ts'))};
    import * as fx from ${JSON.stringify(path.join(storageDir, 'fixtures', 'fakes.ts'))};
    const limits = fx.limits;
    const dir = ${JSON.stringify(dir)};
    const signal = value => fs.writeSync(1, JSON.stringify({ ok: true, signal: value }) + '\\n');
    let out;
    try {
      out = { ok: true, result: await (async () => { ${body} })() };
    } catch (error) {
      out = { ok: false, code: error?.code ?? String(error) };
    }
    process.stdout.write(JSON.stringify(out) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: packageRoot,
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const line = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => {
      out += String(chunk);
      const end = out.indexOf('\n');
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
    });
    void exited.then(() => reject(new Error(`child exited early: ${stderr}`)));
  });
  return { process: child, line, exited };
}
