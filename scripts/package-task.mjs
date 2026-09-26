import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const task = process.argv[2];
if (!['typecheck', 'build'].includes(task)) throw new Error(`Unknown package task: ${task}`);
const directory = process.cwd();
const configFile = ts.readConfigFile(path.join(directory, 'tsconfig.json'), ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, directory);
// An empty shell is valid; no fabricated source or test is needed to make it green.
const errors = config.errors.filter(error => error.code !== 18003);
if (config.fileNames.length) {
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
  errors.push(...ts.getPreEmitDiagnostics(program));
}
if (errors.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => directory, getNewLine: () => '\n',
  }));
  process.exit(1);
}
// Test doubles: `*.test.ts`/`*.spec.ts`, `.d.ts`, `fakes.ts` and anything under a
// `fixtures/` or `browser-harness/` directory, and `fake-*` modules. None of
// these may reach `dist`, so wildcard `exports`
// entries can never resolve to one.
const isTestDouble = relative => /\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)
  || /\.d\.ts$/.test(relative)
  || /(?:^|[\\/])fakes\.[cm]?[jt]sx?$/.test(relative)
  || /(?:^|[\\/])fixtures[\\/]/.test(relative)
  || /(?:^|[\\/])browser-harness[\\/]/.test(relative)
  || /(?:^|[\\/])fake-[^\\/]*\.[cm]?[jt]sx?$/.test(relative);

async function filesBelow(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(filename));
    else files.push(filename);
  }
  return files;
}

if (task === 'build') {
  const output = path.join(directory, 'dist');
  await fs.rm(output, { recursive: true, force: true });
  for (const filename of config.fileNames) {
    const srcPrefix = path.join(directory, 'src') + path.sep;
    if (!filename.startsWith(srcPrefix)) continue;
    const relative = path.relative(path.join(directory, 'src'), filename);
    if (isTestDouble(relative)) continue;
    const result = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: config.options, fileName: filename });
    const destination = path.join(output, relative.replace(/\.tsx?$/, '.js'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, result.outputText);
  }
  // Defence in depth: even if the filter above regresses, dist must never carry a
  // test double, since a wildcard export could still resolve it.
  const leaked = (await filesBelow(output)).map(filename => path.relative(output, filename)).filter(isTestDouble);
  if (leaked.length) throw new Error(`Build emitted test doubles into dist: ${leaked.join(', ')}`);
}
console.log(`${path.basename(directory)}: ${task} passed (${config.fileNames.length} source files)`);
