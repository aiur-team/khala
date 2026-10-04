// Builds the publishable package in packages/agent/npm: the CLI bundled to plain ESM
// (with @khala/contracts inlined, no tsx) plus the local web app. npm/package.json is the
// single source of truth for the published name and version; run sync-release.mjs after
// changing either so the Claude plugin pins match.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const agent = fileURLToPath(new URL('..', import.meta.url));
const npmDir = `${agent}npm`;
const dist = `${npmDir}/dist`;
const manifest = JSON.parse(await fs.readFile(`${npmDir}/package.json`, 'utf8'));
const workspace = JSON.parse(await fs.readFile(`${agent}package.json`, 'utf8'));

// The published runtime dependencies must be exactly what the checkout runs and tests.
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  if (workspace.dependencies?.[name] !== version) {
    throw new Error(`npm/package.json pins ${name}@${version} but packages/agent uses ${workspace.dependencies?.[name]}`);
  }
}

await fs.rm(dist, { recursive: true, force: true });
const external = Object.keys(manifest.dependencies ?? {}).flatMap(name => [name, `${name}/*`]);
const result = await build({
  absWorkingDir: agent,
  entryPoints: { khala: 'src/cli-bundle.ts' },
  outdir: dist,
  outExtension: { '.js': '.mjs' },
  // Chunks sit flat beside khala.mjs: lifecycle.ts and serve.ts resolve ./khala.mjs and ./web/.
  chunkNames: 'chunk-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  conditions: ['khala-source'],
  external,
  define: { __KHALA_BUNDLE__: JSON.stringify({ name: manifest.name, version: manifest.version }) },
  banner: { js: "import { createRequire as __khalaCreateRequire } from 'node:module'; const require = __khalaCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
const entry = `${dist}/khala.mjs`;
await fs.writeFile(entry, '#!/usr/bin/env node\n' + await fs.readFile(entry, 'utf8'));
await fs.chmod(entry, 0o755);

// Nothing outside the declared dependencies and node: built-ins may stay unbundled.
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!imported.external || imported.path.startsWith('node:') || imported.path.startsWith('./')) continue;
    if (!external.some(pattern => imported.path === pattern || (pattern.endsWith('/*') && imported.path.startsWith(pattern.slice(0, -1))))) {
      throw new Error(`unbundled import ${imported.path}`);
    }
  }
}

// The local web app that `khala local serve` hosts (src/local/serve.ts defaultWebDir).
const web = spawnSync('pnpm', ['--filter', '@khala/web', 'build:local'], { cwd: agent, stdio: 'inherit' });
if (web.status !== 0) throw new Error('pnpm --filter @khala/web build:local failed');
await fs.cp(fileURLToPath(new URL('../../../apps/web/dist-local', import.meta.url)), `${dist}/web`, { recursive: true });

console.log(`built ${manifest.name}@${manifest.version} into ${dist}`);
