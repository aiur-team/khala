// Bundles the `khala` bin and its whole runtime closure (workspace connector and
// contracts included) into one self-contained file, so the published package has
// no runtime dependencies and no import can resolve into this workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

/** Returns the esbuild metafile so the package gate can audit the bundled closure. */
export async function bundle({
  entryPoint = path.join(packageDirectory, 'src/cli/main.ts'),
  outfile = path.join(packageDirectory, 'dist/khala.js'),
  absWorkingDir = packageDirectory,
} = {}) {
  await fs.rm(path.dirname(outfile), { recursive: true, force: true });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundle();
