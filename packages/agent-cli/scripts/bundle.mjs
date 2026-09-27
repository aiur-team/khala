// Bundles the `khala` bin and its whole runtime closure (workspace connector and
// contracts included) into one self-contained file, so the published package has
// no runtime dependencies and no import can resolve into this workspace.
//
// `khala internal` runs a second self-contained file, `khala-internal.js`, built
// from the internal application's composition entry. The bin loads it only for
// that command, so no other command loads the store, the server or node:sqlite.
//
// `opencode.js` is the self-contained OpenCode plugin (`@aiur/khala/opencode`). OpenCode
// imports it in its own process, so it too carries its whole closure.
import { spawnSync } from 'node:child_process';
//
// `payload/` carries the reviewed harness assets `khala setup` installs: the Claude plugin's
// shipped files and the Codex skill.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

export const INTERNAL_WEB_SOURCE = path.resolve(packageDirectory, '../../apps/web/dist/internal-web');

export const INTERNAL_ENTRY_POINT = path.resolve(packageDirectory, '../../apps/internal/src/composition/internal-cli.ts');
/** Top-level Claude plugin entries that ship; sources, tests, and package metadata do not. */
const CLAUDE_PLUGIN_ENTRIES = ['.claude-plugin', '.mcp.json', 'hooks', 'skills'];

async function copyPayload(workingDirectory, distDirectory) {
  const claudePlugin = path.resolve(workingDirectory, '../claude-plugin');
  const codexSkill = path.resolve(workingDirectory, '../agent-skill/SKILL.md');
  // A detached copy of this package has neither; the gate's file allowlist then refuses it.
  if (!existsSync(claudePlugin) || !existsSync(codexSkill)) return;
  for (const entry of CLAUDE_PLUGIN_ENTRIES) {
    await fs.cp(path.join(claudePlugin, entry), path.join(distDirectory, 'payload/claude-plugin', entry), { recursive: true });
  }
  await fs.mkdir(path.join(distDirectory, 'payload/codex'), { recursive: true });
  await fs.copyFile(codexSkill, path.join(distDirectory, 'payload/codex/SKILL.md'));
}

async function buildOne({ entryPoint, outfile, absWorkingDir }) {
  const result = await build({
    absWorkingDir,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    conditions: ['khala-source'],
    metafile: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  await fs.writeFile(`${outfile}.meta.json`, JSON.stringify(result.metafile));
  return result.metafile;
}

/** Builds only `opencode.js`, exactly as `bundle` ships it; the plugin's integration test loads this. */
export async function bundleOpenCodePlugin({
  outfile = path.join(packageDirectory, 'dist/opencode.js'),
  absWorkingDir = packageDirectory,
} = {}) {
  return buildOne({ entryPoint: path.join(absWorkingDir, 'src/opencode/index.ts'), outfile, absWorkingDir });
}

/** Returns the esbuild metafile so the package gate can audit the bundled closure. */
export async function bundle({
  entryPoint = path.join(packageDirectory, 'src/cli/main.ts'),
  outfile = path.join(packageDirectory, 'dist/khala.js'),
  absWorkingDir = packageDirectory,
  internalEntryPoint = INTERNAL_ENTRY_POINT,
  internalWebSource = INTERNAL_WEB_SOURCE,
} = {}) {
  await fs.rm(path.dirname(outfile), { recursive: true, force: true });
  const metafile = await buildOne({ entryPoint, outfile, absWorkingDir });
  await bundleOpenCodePlugin({ outfile: path.join(path.dirname(outfile), 'opencode.js'), absWorkingDir });
  // A detached copy of this package (as the package gate's fixtures make) has no
  // internal application beside it; the gate's file allowlist then refuses it.
  if (internalEntryPoint && existsSync(internalEntryPoint)) {
    await buildOne({ entryPoint: internalEntryPoint, outfile: path.join(path.dirname(outfile), 'khala-internal.js'), absWorkingDir });
  }
  // `khala internal` serves `internal-web/` beside `khala-internal.js`. Build it from the
  // web workspace when no earlier `pnpm --filter @khala/web build` left one behind.
  if (internalEntryPoint && existsSync(internalEntryPoint)) {
    if (!existsSync(path.join(internalWebSource, 'index.html'))) {
      const web = spawnSync('pnpm', ['--filter', '@khala/web', 'build:internal'], { cwd: packageDirectory, stdio: ['ignore', 2, 2] });
      if (web.status !== 0 || !existsSync(path.join(internalWebSource, 'index.html'))) throw new Error(`internal web bundle missing at ${internalWebSource} and "pnpm --filter @khala/web build:internal" did not produce it`);
    }
    await fs.cp(internalWebSource, path.join(path.dirname(outfile), 'internal-web'), { recursive: true });
  }
  await copyPayload(absWorkingDir, path.dirname(outfile));
  return metafile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundle();
