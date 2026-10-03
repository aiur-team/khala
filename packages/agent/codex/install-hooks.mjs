// Checkout installer: registers the PATH-based `khala hook deliver --harness codex`.
// The published package's `khala install codex` uses the same merge with an absolute command.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeCodexHooks } from './hooks-config.mjs';

async function main() {
  const [action, flag, home, ...extra] = process.argv.slice(2);
  if (!['install', 'uninstall'].includes(action) || extra.length
    || (flag !== undefined && (flag !== '--codex-home' || !home))) {
    throw new Error('usage: install-hooks.mjs install|uninstall [--codex-home <dir>]');
  }
  const directory = home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const file = path.join(directory, 'hooks.json');
  let original = '{"hooks":{}}\n';
  let mode = 0o600;
  try {
    original = await fs.readFile(file, 'utf8');
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { config, warnings } = mergeCodexHooks(JSON.parse(original), action);
  if (action === 'install') {
    await fs.mkdir(directory, { recursive: true });
    try { await fs.writeFile(file + '.khala-bak', original, { flag: 'wx', mode }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const warning of warnings) console.error(warning);
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode });
  console.log(action === 'install' ? 'installed; restart or resume Codex and trust the Khala hooks' : 'uninstalled');
}
main().catch(() => { console.error('hooks_install_failed'); process.exitCode = 1; });
