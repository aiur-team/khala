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
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

export const INTERNAL_ENTRY_POINT = path.resolve(packageDirectory, '../../apps/internal/src/composition/internal-cli.ts');

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

/** Returns the esbuild metafile so the package gate can audit the bundled closure. */
export async function bundle({
  entryPoint = path.join(packageDirectory, 'src/cli/main.ts'),
  outfile = path.join(packageDirectory, 'dist/khala.js'),
  absWorkingDir = packageDirectory,
  internalEntryPoint = INTERNAL_ENTRY_POINT,
} = {}) {
  await fs.rm(path.dirname(outfile), { recursive: true, force: true });
  const metafile = await buildOne({ entryPoint, outfile, absWorkingDir });
  await buildOne({ entryPoint: path.join(absWorkingDir, 'src/opencode/index.ts'), outfile: path.join(path.dirname(outfile), 'opencode.js'), absWorkingDir });
  // A detached copy of this package (as the package gate's fixtures make) has no
  // internal application beside it; the gate's file allowlist then refuses it.
  if (internalEntryPoint && existsSync(internalEntryPoint)) {
    await buildOne({ entryPoint: internalEntryPoint, outfile: path.join(path.dirname(outfile), 'khala-internal.js'), absWorkingDir });
  }
  return metafile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundle();
