// Stages the npm package in dist/: the workspace exports TypeScript source as @khala/listener, while npm
// gets built JavaScript, declarations and the language-neutral spec as `khala-listener`.
import { execFileSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const dir = fileURLToPath(new URL('..', import.meta.url));
const out = dir + 'dist/';
execFileSync(process.execPath, ['../../scripts/package-task.mjs', 'build'], { cwd: dir, stdio: 'inherit' });
const program = ts.createProgram([dir + 'src/index.ts'], {
  declaration: true, emitDeclarationOnly: true, outDir: out, rootDir: dir + 'src', strict: true, skipLibCheck: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts'], types: ['node'],
});
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics];
if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, ts.createCompilerHost({})));
await cp(dir + 'spec', out + 'spec', { recursive: true });
await cp(dir + 'README.md', out + 'README.md');
await cp(dir + '../agent/npm/LICENSE', out + 'LICENSE');
const { version, engines } = JSON.parse(await readFile(dir + 'package.json', 'utf8'));
await writeFile(out + 'package.json', JSON.stringify({
  name: 'khala-listener', version,
  description: 'Khala listener reference: listening modes, wake and delivery rules, frame bounds, hook codecs and spec goldens.',
  license: 'Apache-2.0', type: 'module', engines,
  repository: { type: 'git', url: 'git+https://github.com/aiur-team/khala.git', directory: 'packages/listener' },
  exports: { '.': { types: './index.d.ts', default: './index.js' }, './spec/*': './spec/*' },
}, null, 2) + '\n');
console.log(`Staged khala-listener@${version} in ${out}`);
