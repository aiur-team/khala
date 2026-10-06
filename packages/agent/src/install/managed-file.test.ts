import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedFiles, formatJson, jsonFormat, pruneCreated, readManaged, textFormat } from './managed-file';
import { runInstall } from './main';

let home: string;
let state: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-managed-')); state = path.join(home, 'state'); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

type Json = Record<string, unknown>;
/** A stand-in installer: Khala owns `mcpServers.khala`. */
const install = async (file: string) => {
  const current = await readManaged(file);
  const value = jsonFormat.parse(current.text ?? '') as Json;
  const servers = { ...(value.mcpServers as Json | undefined), khala: { command: 'khala' } };
  await new ManagedFiles(state).write([{ current, text: formatJson({ ...value, mcpServers: servers }, current.text) }]);
};
const uninstall = async (file: string) => {
  await new ManagedFiles(state).restore(await readManaged(file), jsonFormat, value => {
    const servers = { ...((value as Json).mcpServers as Json | undefined) };
    delete servers.khala;
    return { ...(value as Json), mcpServers: servers };
  });
};
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

describe('managed JSON file', () => {
  it('leaves an absent file absent, with the directories it created', async () => {
    const file = path.join(home, 'cfg', 'tool', 'settings.json');
    await install(file);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ mcpServers: { khala: { command: 'khala' } } });
    await uninstall(file);
    expect(await exists(path.join(home, 'cfg'))).toBe(false);
    expect(await exists(path.join(state, 'install-originals.json'))).toBe(false);
  });

  it.each([
    ['no trailing newline', '{"model":"x"}'],
    ['odd formatting', '{\r\n\t"model" :   "x",\r\n\t"list": [ 1,2 ],"mcpServers":{ "other" : {} }\r\n}\r\n'],
    ['a BOM and an empty container', '﻿{ "mcpServers": {} }\n\n'],
  ])('restores the exact bytes of a file with %s', async (_, original) => {
    const file = path.join(home, 'settings.json');
    await fs.writeFile(file, original);
    await install(file);
    const installed = await fs.readFile(file, 'utf8');
    expect(installed).not.toBe(original);
    expect(installed.startsWith('﻿')).toBe(original.startsWith('﻿'));
    expect(installed.includes('\r\n')).toBe(original.includes('\r\n'));
    expect(installed.endsWith('\n')).toBe(original.endsWith('\n'));
    await uninstall(file);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readdir(home)).toEqual(['settings.json', 'state']);
    expect(await fs.readdir(state)).toEqual([]);
  });

  it('keeps the first recording across reinstalls', async () => {
    const file = path.join(home, 'settings.json');
    const original = '{"model": "x"}';
    await fs.writeFile(file, original);
    await install(file);
    await install(file);
    await install(file);
    await uninstall(file);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    // The next install records afresh.
    await fs.writeFile(file, '{"model": "y"}\n');
    await install(file);
    await uninstall(file);
    expect(await fs.readFile(file, 'utf8')).toBe('{"model": "y"}\n');
  });

  it('keeps later user edits and prunes only the containers Khala created', async () => {
    const file = path.join(home, 'settings.json');
    await fs.writeFile(file, '{\n    "model": "x",\n    "hooks": {}\n}\n');
    await install(file);
    const edited = JSON.parse(await fs.readFile(file, 'utf8')) as Json;
    await fs.writeFile(file, JSON.stringify({ ...edited, model: 'y' }, null, 4) + '\n');
    await uninstall(file);
    expect(await fs.readFile(file, 'utf8')).toBe('{\n    "model": "y",\n    "hooks": {}\n}\n');
    expect(await exists(path.join(state, 'install-originals.json'))).toBe(false);
  });

  it('keeps a file the user created after an install into an absent path', async () => {
    const file = path.join(home, 'settings.json');
    await install(file);
    await fs.writeFile(file, JSON.stringify({ model: 'mine', mcpServers: { khala: { command: 'khala' } } }));
    await uninstall(file);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ model: 'mine' });
  });

  it('adopts a legacy .khala-bak as the original and removes it', async () => {
    const file = path.join(home, 'settings.json');
    await fs.writeFile(file + '.khala-bak', '{ "model":"x" }');
    await fs.writeFile(file, '{\n  "model": "x",\n  "mcpServers": {\n    "khala": {}\n  }\n}\n');
    await install(file);
    expect(await exists(file + '.khala-bak')).toBe(false);
    await uninstall(file);
    expect(await fs.readFile(file, 'utf8')).toBe('{ "model":"x" }');
  });

  it('prunes nested empty containers absent from the original', () => {
    expect(pruneCreated({ a: { b: {}, c: [] }, d: {}, e: 1 }, { d: {} })).toEqual({ d: {}, e: 1 });
    expect(textFormat.equal('a = 1\n\n[b]\nc = 2', 'a = 1  \n[b]\nc = 2\n\n')).toBe(true);
  });
});

describe('khala install codex (TOML and JSON)', () => {
  const codex = () => path.join(home, '.codex');
  const run = (argv: string[]) => runInstall(argv, {
    env: { HOME: home }, package: { name: 'khala-cli', version: '9.8.7' },
    npmInstall: () => true, stdout: () => undefined, stderr: () => undefined,
  });

  it('leaves absent config files and the Codex directory absent', async () => {
    expect(await run(['codex', '--no-wake'])).toBe(0);
    expect((await fs.readdir(codex())).sort()).toEqual(['config.toml', 'hooks.json']);
    expect(await run(['codex', '--uninstall'])).toBe(0);
    expect(await exists(codex())).toBe(false);
  });

  it('restores odd formatting and a missing final newline byte for byte, across reinstalls', async () => {
    await fs.mkdir(codex());
    const toml = 'model   = "x"\r\n\r\n[mcp_servers.other]\ncommand = "o"';
    const hooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"mine"}]}]}}';
    await fs.writeFile(path.join(codex(), 'config.toml'), toml);
    await fs.writeFile(path.join(codex(), 'hooks.json'), hooks);
    expect(await run(['codex', '--no-wake'])).toBe(0);
    expect(await run(['codex', '--no-wake'])).toBe(0);
    expect(await run(['codex', '--uninstall'])).toBe(0);
    expect(await fs.readFile(path.join(codex(), 'config.toml'), 'utf8')).toBe(toml);
    expect(await fs.readFile(path.join(codex(), 'hooks.json'), 'utf8')).toBe(hooks);
    expect((await fs.readdir(codex())).sort()).toEqual(['config.toml', 'hooks.json']);
  });

  it('keeps TOML edits made after install and removes only the Khala table', async () => {
    await fs.mkdir(codex());
    await fs.writeFile(path.join(codex(), 'config.toml'), 'model = "x"\n');
    expect(await run(['codex', '--no-wake'])).toBe(0);
    const installed = await fs.readFile(path.join(codex(), 'config.toml'), 'utf8');
    await fs.writeFile(path.join(codex(), 'config.toml'), installed.replace('model = "x"', 'model = "y"'));
    expect(await run(['codex', '--uninstall'])).toBe(0);
    expect(await fs.readFile(path.join(codex(), 'config.toml'), 'utf8')).toBe('model = "y"\n');
    expect(await exists(path.join(codex(), 'hooks.json'))).toBe(false);
  });
});

it.skipIf(process.platform === 'win32')('creates private recording directories', async () => {
  await install(path.join(home, 'config.json'));
  expect((await fs.stat(state)).mode & 0o077).toBe(0);
});
