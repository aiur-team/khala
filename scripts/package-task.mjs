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
if (task === 'build') {
  const output = path.join(directory, 'dist');
  await fs.rm(output, { recursive: true, force: true });
  for (const filename of config.fileNames) {
    if (/\.(test|spec)\.[cm]?tsx?$|\.d\.ts$/.test(filename) || !filename.startsWith(path.join(directory, 'src') + path.sep)) continue;
    const relative = path.relative(path.join(directory, 'src'), filename).replace(/\.tsx?$/, '.js');
    const result = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: config.options, fileName: filename });
    const destination = path.join(output, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, result.outputText);
  }
}
console.log(`${path.basename(directory)}: ${task} passed (${config.fileNames.length} source files)`);
