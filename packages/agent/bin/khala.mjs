#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { register } from 'tsx/esm/api';

register();
const HOOK_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const STDIN_CAP = 1024 * 1024;
const [cmd, ...rest] = process.argv.slice(2);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > STDIN_CAP) return '';
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function exitWith(code) { process.exitCode = code; }

if (cmd === '--version') {
  const { KHALA_AGENT_VERSION } = await import('../src/version.ts');
  console.log(KHALA_AGENT_VERSION);
  exitWith(0);
} else if (cmd === 'mcp') {
  const url = new URL('../src/mcp/main.ts', import.meta.url);
  if (!existsSync(url)) { console.error('khala: mcp not available'); exitWith(1); }
  else {
    try {
      const code = await (await import(url.href)).default(rest);
      if (typeof code !== 'number' || !Number.isInteger(code)) throw new Error('bad_exit');
      exitWith(code);
    } catch { console.error('khala: internal_error'); exitWith(1); }
  }
} else if (cmd === 'hook') {
  const [name = '', ...args] = rest;
  const url = new URL(`../hooks/${name}.ts`, import.meta.url);
  if (!HOOK_NAME.test(name) || !existsSync(url)) { console.error(`khala: unknown hook ${name}`); exitWith(1); }
  else {
    try {
      const code = await (await import(url.href)).default(await readStdin(), args);
      if (typeof code !== 'number' || !Number.isInteger(code)) throw new Error('bad_exit');
      exitWith(code);
    } catch { process.stderr.write('{"ok":false,"warning":"khala_hook_suppressed","code":"internal_error"}\n'); exitWith(1); }
  }
} else {
  console.error('usage: khala mcp | khala hook <name> | khala --version');
  exitWith(1);
}
