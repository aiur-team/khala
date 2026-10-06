import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let fixture: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'km103-bin-'));
  await mkdir(join(fixture, 'bin'));
  await mkdir(join(fixture, 'src/mcp'), { recursive: true });
  await mkdir(join(fixture, 'src/local'), { recursive: true });
  await mkdir(join(fixture, 'hooks'));
  await copyFile(new URL('../bin/khala.mjs', import.meta.url), join(fixture, 'bin/khala.mjs'));
  for (const file of ['version.ts', 'bundle.ts', 'cli.ts']) await copyFile(new URL(`./${file}`, import.meta.url), join(fixture, 'src', file));
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(fixture, 'node_modules'), 'dir');
});
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

function run(args: string[], stdin = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(fixture, 'bin/khala.mjs'), ...args], { stdio: 'pipe', env: { ...process.env, FORCE_COLOR: '0' } });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    // A capped hook may close its pipe before a large input finishes writing.
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
const hook = (name: string, body: string) => writeFile(join(fixture, 'hooks', `${name}.ts`), body);
const suppressed = '{"ok":false,"warning":"khala_hook_suppressed","code":"internal_error"}\n';
const echo = `export default async function run(stdin: string, argv: readonly string[]): Promise<number> {
  console.log(JSON.stringify({stdin, argv})); return 0;
}`;

describe('C12 source dispatcher', () => {
  it('prints the version and reports usage for unknown commands', async () => {
    expect(await run(['--version'])).toEqual({ code: 0, stdout: '0.0.0\n', stderr: '' });
    for (const args of [[], ['bogus']]) expect(await run(args)).toEqual({ code: 1, stdout: '', stderr: 'usage: khala mcp | khala watch [--harness claude|codex|cursor --session <id>] | khala hook <name> | khala local <command> | khala install codex | khala install cursor | khala wake on|off|status [--driver <d>] [--harness <id>] [--json] | khala --version\n' });
  });
  it('reports absent MCP modules and passes argv and the module exit code', async () => {
    expect(await run(['mcp'])).toEqual({ code: 1, stdout: '', stderr: 'khala: mcp not available\n' });
    await writeFile(join(fixture, 'src/mcp/main.ts'), 'export default async function main(argv: readonly string[]): Promise<number> { return argv.length; }');
    expect(await run(['mcp', 'a', 'b'])).toEqual({ code: 2, stdout: '', stderr: '' });
  });
  it('dispatches local arguments and suppresses missing or broken modules', async () => {
    expect(await run(['local'])).toEqual({ code: 1, stdout: '{"error":"internal_error"}\n', stderr: '' });
    await writeFile(join(fixture, 'src/local/cli.ts'), 'export default async (argv) => argv.length;');
    expect(await run(['local', 'a', 'b'])).toEqual({ code: 2, stdout: '', stderr: '' });
    for (const body of ['throw new Error("secret");', 'return "bad";', 'return NaN;']) {
      await writeFile(join(fixture, 'src/local/cli.ts'), `export default async () => { ${body} };`);
      expect(await run(['local'])).toEqual({ code: 1, stdout: '{"error":"internal_error"}\n', stderr: '' });
    }
  });
  it('passes UTF-8 stdin and arguments to a dynamically discovered TypeScript hook', async () => {
    await hook('echo', echo);
    const result = await run(['hook', 'echo', '--harness', 'codex'], '{"x":"🌍"}');
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ stdin: '{"x":"🌍"}', argv: ['--harness', 'codex'] });
  });
  it('rejects missing and invalid hook names with exit 1', async () => {
    for (const name of ['nope', '../x', '', 'Upper', 'a'.repeat(33)]) {
      expect(await run(['hook', name])).toEqual({ code: 1, stdout: '', stderr: `khala: unknown hook ${name}\n` });
    }
  });
  it('preserves exit 2 returned by a hook', async () => {
    await hook('wake', 'export default async function run(): Promise<number> { return 2; }');
    expect(await run(['hook', 'wake'])).toEqual({ code: 2, stdout: '', stderr: '' });
  });
  it('suppresses thrown errors and invalid return values for both module types', async () => {
    for (const body of ['throw new Error("secret-x");', 'return "bad";', 'return NaN;']) {
      await hook('broken', `export default async function run() { ${body} }`);
      expect(await run(['hook', 'broken'])).toEqual({ code: 1, stdout: '', stderr: suppressed });
      await writeFile(join(fixture, 'src/mcp/main.ts'), `export default async function main() { ${body} }`);
      expect(await run(['mcp'])).toEqual({ code: 1, stdout: '', stderr: 'khala: internal_error\n' });
    }
  });
  it('accepts exactly 1 MiB and discards larger stdin', async () => {
    await hook('size', 'export default async function run(stdin: string) { console.log(Buffer.byteLength(stdin)); return 0; }');
    expect(await run(['hook', 'size'], 'x'.repeat(1024 * 1024))).toEqual({ code: 0, stdout: '1048576\n', stderr: '' });
    expect(await run(['hook', 'size'], 'x'.repeat(1024 * 1024 + 1))).toEqual({ code: 0, stdout: '0\n', stderr: '' });
  });
  it('loads extensionless relative imports through tsx', async () => {
    await hook('value', 'export const value: number = 0;');
    await hook('nested', 'import { value } from "./value"; export default async function run(): Promise<number> { return value; }');
    expect(await run(['hook', 'nested'])).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});

it('dispatches wake commands lazily and preserves invalid-choice exit 2', async () => {
  expect(await run(['wake', 'status'])).toEqual({ code: 1, stdout: '', stderr: 'khala: wake not available\n' });
  await mkdir(join(fixture, 'src/wake'));
  await writeFile(join(fixture, 'src/wake/cli.ts'), `export default async function run(argv: readonly string[]) { console.log(JSON.stringify(argv)); return 2; }`);
  expect(await run(['wake', 'on', '--driver', 'bad'])).toEqual({ code: 2, stdout: '["on","--driver","bad"]\n', stderr: '' });
});
