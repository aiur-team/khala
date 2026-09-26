import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalCommand, InternalCommandIo } from '@khala/contracts/internal/command';
import { runCli } from './app.js';
import { CliError } from './errors.js';
import { INTERNAL_RUNTIME_FILE, bundledInternalRuntime, parseInternalArguments } from './internal.js';
import type { AgentClientPort, InternalRuntimeLoader } from './types.js';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function streams() {
  const stdin = new PassThrough(); stdin.end('');
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = ''; let err = '';
  stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
  return { stdin, stdout, stderr, output: () => out, error: () => err };
}

const idleClient: AgentClientPort = {
  async connect() { return { kind: 'unavailable' }; },
  async send(input) { return { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId }; },
  async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
  async listChannels() { throw new Error('internal command tests should not list channels'); },
  async listAgents() { throw new Error('internal command tests should not list agents'); },
};

function recordingLoader(exit = 0) {
  const commands: InternalCommand[] = [];
  const ios: InternalCommandIo[] = [];
  let loads = 0;
  const loader: InternalRuntimeLoader = async () => {
    loads += 1;
    return {
      async runInternalCommand(command, io) {
        commands.push(command); ios.push(io);
        await io.stdout.write('{"ok":true}\n');
        return exit;
      },
    };
  };
  return { loader, commands, ios, loads: () => loads };
}

describe('khala internal arguments', () => {
  it('parses the closed grammar', () => {
    expect(parseInternalArguments([])).toEqual({ kind: 'create' });
    expect(parseInternalArguments(['--resume', 'ch_abc-_.~1'])).toEqual({ kind: 'resume', channelId: 'ch_abc-_.~1' });
    expect(parseInternalArguments(['delete', 'ch_1'])).toEqual({ kind: 'delete', channelId: 'ch_1', confirmed: false });
    expect(parseInternalArguments(['delete', 'ch_1', '--yes'])).toEqual({ kind: 'delete', channelId: 'ch_1', confirmed: true });
    expect(parseInternalArguments(['export', 'ch_1', '--format', 'markdown', '--output', 'out.md']))
      .toEqual({ kind: 'export', channelId: 'ch_1', format: 'markdown', output: 'out.md', replace: false });
    expect(parseInternalArguments(['export', 'ch_1', '--replace', '--output', '/tmp/o.jsonl', '--format', 'jsonl']))
      .toEqual({ kind: 'export', channelId: 'ch_1', format: 'jsonl', output: '/tmp/o.jsonl', replace: true });
  });

  it('rejects extra, mixed, repeated, and malformed arguments', () => {
    for (const args of [
      ['--resume'], ['--resume', 'ch_1', 'extra'], ['--resume', '../x'], ['--resume', 'a/b'], ['--resume', '.'],
      ['--resume=ch_1'], ['resume', 'ch_1'], ['ch_1'], ['--port', '4870'], ['delete'], ['delete', 'ch_1', '--force'],
      ['delete', 'ch_1', '--yes', '--yes'], ['export', 'ch_1'], ['export', 'ch_1', '--format', 'markdown'],
      ['export', 'ch_1', '--format', 'pdf', '--output', 'x'], ['export', 'ch_1', '--format', 'markdown', '--output'],
      ['export', 'ch_1', '--format', 'markdown', '--format', 'jsonl', '--output', 'x'],
      ['export', 'ch_1', '--format', 'markdown', '--output', 'x', '--replace', '--replace'],
      ['export', 'ch_1', '--format', 'markdown', '--output', '--replace'],
      ['export', 'ch_1', '--format', 'markdown', '--output', 'x', '--resume', 'ch_2'],
      ['--resume', 'ch_1', 'delete', 'ch_1', '--yes'], ['delete', '--yes'], ['--resume', '--help'], ['--resume', '-ch_1'],
    ]) {
      expect(() => parseInternalArguments(args), args.join(' ')).toThrow(CliError);
    }
  });
});

describe('khala internal discovery arguments', () => {
  it('parses the discovery grammar with optional untrusted labels', () => {
    expect(parseInternalArguments(['discovery', '--harness', 'codex', '--session', '019a-7f'])).toEqual({
      kind: 'discovery', harness: 'codex', sessionId: '019a-7f', displayLabel: null, workspaceLabel: null,
    });
    expect(parseInternalArguments(['discovery', '--workspace', 'Khala repo', '--session', 's1', '--label', 'Build agent', '--harness', 'opencode']))
      .toEqual({ kind: 'discovery', harness: 'opencode', sessionId: 's1', displayLabel: 'Build agent', workspaceLabel: 'Khala repo' });
  });

  it('rejects missing, repeated, unknown and malformed discovery arguments', () => {
    for (const args of [
      ['discovery'], ['discovery', '--harness', 'codex'], ['discovery', '--session', 's1'],
      ['discovery', '--harness', 'codex', '--session', 's1', '--harness', 'claude'],
      ['discovery', '--harness', 'codex', '--session', 's1', '--channel', 'ch_1'],
      ['discovery', '--harness', 'Codex', '--session', 's1'], ['discovery', '--harness', 'codex', '--session', 'has space'],
      ['discovery', '--harness', 'codex', '--session', 's1', '--label', 'two\nlines'],
      ['discovery', '--harness', 'codex', '--session', 's1', '--label', ''],
      ['discovery', '--harness', 'codex', '--session', 's1', '--workspace'],
    ]) {
      expect(() => parseInternalArguments(args), args.join(' ')).toThrow(CliError);
    }
  });
});

describe('khala internal delegation', () => {
  it('hands the exact parsed command and process context to the lazily loaded runtime', async () => {
    const io = streams();
    const recorded = recordingLoader(3);
    const signal = new AbortController().signal;
    const code = await runCli(['internal', 'delete', 'ch_1', '--yes'], {
      client: idleClient, inbox: async () => { throw new Error('unused'); }, ...io,
      internal: recorded.loader, env: { XDG_STATE_HOME: '/state' }, cwd: '/work', signal,
    });
    expect(code).toBe(3);
    expect(recorded.commands).toEqual([{ kind: 'delete', channelId: 'ch_1', confirmed: true }]);
    expect(recorded.ios[0]).toMatchObject({ env: { XDG_STATE_HOME: '/state' }, cwd: '/work', signal });
    expect(io.output()).toBe('{"ok":true}\n');
  });

  it('never loads the internal runtime for other commands or refused arguments', async () => {
    const recorded = recordingLoader();
    for (const argv of [['status'], ['internal', '--resume'], ['internal', 'export', 'ch_1'], ['bogus']]) {
      const io = streams();
      await runCli(argv, { client: idleClient, inbox: async () => { throw new Error('unused'); }, ...io, internal: recorded.loader });
    }
    expect(recorded.loads()).toBe(0);
  });

  it('reports an unavailable runtime without crashing', async () => {
    for (const internal of [undefined, async () => { throw new Error('missing'); }]) {
      const io = streams();
      const code = await runCli(['internal'], {
        client: idleClient, inbox: async () => { throw new Error('unused'); }, ...io, ...(internal ? { internal } : {}),
      });
      expect(code).toBe(2);
      expect(JSON.parse(io.error())).toEqual({ ok: false, error: 'internal_unavailable' });
    }
  });

  it('loads only a runtime module beside the entry that exports runInternalCommand', async () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-internal-loader-'));
    temporary.push(directory);
    const entry = new URL(`file://${path.join(directory, 'khala.js')}`).href;
    await expect(bundledInternalRuntime(entry)()).rejects.toThrow();
    fs.writeFileSync(path.join(directory, INTERNAL_RUNTIME_FILE), 'export const other = 1;\n');
    await expect(bundledInternalRuntime(entry)()).rejects.toThrow('internal runtime');
    const good = path.join(directory, 'good');
    fs.mkdirSync(good);
    fs.writeFileSync(path.join(good, INTERNAL_RUNTIME_FILE), 'export async function runInternalCommand() { return 7; }\n');
    const runtime = await bundledInternalRuntime(new URL(`file://${path.join(good, 'khala.js')}`).href)();
    expect(await runtime.runInternalCommand({ kind: 'create' }, {} as InternalCommandIo)).toBe(7);
  });
});
