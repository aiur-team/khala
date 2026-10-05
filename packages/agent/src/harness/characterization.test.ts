import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { validAgentRejoinSecret } from '@khala/contracts/m1/agent-join';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import runDeliver from '../../hooks/deliver';
import { openSessionDir, readStateFile, sessionFiles, writeStatus, writeStateFile } from '../state';
import { appendEntries, readCursor, unread } from '../inbox';
import { readActivity } from '../activity';
import { cursorSessionId } from '../cursor';
import { resolveHarness, resolveSessionId } from '../mcp/session-id';
import { createRealClientFactory } from '../mcp/wiring';
import { createPlaceholderClient } from '../mcp/main';
import { createKhalaAgentClient, type KhalaAgentClientOptions } from '../client-impl';
import { requestJoin } from '../join';
import { runInstall } from '../install/main';
import { runCli, type CliModules } from '../cli';

// U2 baselines must remain unchanged through U3/U3b. Review any golden update
// as a behavior change, not as routine test maintenance.
const goldenDir = fileURLToPath(new URL('./__golden__/', import.meta.url));
const harnesses = ['claude', 'codex', 'cursor'] as const;
const modes = ['steer', 'sync', 'async'] as const;
const events = {
  claude: ['UserPromptSubmit', 'PostToolUse', 'Stop'],
  codex: ['UserPromptSubmit', 'PostToolUse', 'Stop'],
  cursor: ['beforeSubmitPrompt', 'postToolUse', 'stop'],
} as const;
const workspace = '/work/project';
const instant = new Date('2026-10-05T12:00:00.000Z');
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-characterization-'));
  vi.stubEnv('XDG_STATE_HOME', root);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(instant);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

const entry = (index: number): InboxEntry => ({
  eventId: `$message-${index}`, roomId: '!room:khala.local', ts: instant.toISOString(),
  sender: '@maya:khala.local', senderLabel: 'Maya', senderKind: 'human', kind: 'message',
  body: `Message ${index}: café 👋`,
});
const sessionId = (harness: Harness) => harness === 'cursor' ? cursorSessionId(workspace) : 'session';
async function seed(harness: Harness, mode: string, count: number) {
  const files = await openSessionDir(harness, sessionId(harness), { XDG_STATE_HOME: root });
  await appendEntries(files, Array.from({ length: count }, (_, i) => entry(i + 1)));
  await writeStatus(files, 'connected', undefined, () => instant, 'Release "room"', 'Scout');
  await writeStateFile(files.dir, 'mode.json', { mode });
  return files;
}
function payload(harness: Harness, event: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ hook_event_name: event,
    ...(harness === 'cursor' ? { workspace_roots: [workspace], loop_count: 0 }
      : { session_id: 'session' }), ...extra });
}
async function hook(harness: string, stdin: string) {
  let stdout = '', stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(text => { stdout += String(text); return true; });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(text => { stderr += String(text); return true; });
  try { return { code: await runDeliver(stdin, ['--harness', harness]), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}
async function golden(name: string, value: unknown) {
  expect(JSON.stringify(value, null, 2) + '\n').toBe(await fs.readFile(path.join(goldenDir, name + '.json'), 'utf8'));
}

describe('public deliver entry point', () => {
  for (const harness of harnesses) {
    for (const event of events[harness]) {
      for (const mode of modes) {
        it.each([0, 1, 51])(`${harness} ${event} ${mode} with %i inbox entries`, async count => {
          const files = await seed(harness, mode, count);
          const output = await hook(harness, payload(harness, event));
          await golden(`deliver-${harness}-${event}-${mode}-${count}`, {
            ...output, cursor: await readCursor(files), activity: await readActivity(files),
            unread: (await unread(files)).entries.map(item => item.eventId),
          });
        });
      }
    }
  }
  it.each(['claude', 'codex'] as const)('%s active Stop records idle and preserves unread entries', async harness => {
    const files = await seed(harness, 'sync', 1);
    await golden(`stop-active-${harness}`, {
      ...await hook(harness, payload(harness, 'Stop', { stop_hook_active: true })),
      activity: await readActivity(files), cursor: await readCursor(files),
      unread: (await unread(files)).entries.map(item => item.eventId),
    });
  });
  it('Cursor accepts BOM stdin and suppresses a second stop follow-up', async () => {
    const files = await seed('cursor', 'sync', 1);
    const first = await hook('cursor', '\uFEFF' + payload('cursor', 'stop'));
    expect(first.stdout).toBe(await fs.readFile(path.join(goldenDir, 'cursor-bom-stdout.txt'), 'utf8'));
    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: '' });
    await appendEntries(files, [entry(2)]);
    await golden('cursor-loop-count', {
      ...await hook('cursor', payload('cursor', 'stop', { loop_count: 1 })),
      activity: await readActivity(files), cursor: await readCursor(files),
      unread: (await unread(files)).entries.map(item => item.eventId),
    });
  });
  it('unknown harness preserves the suppressed-hook exit code and streams', async () => {
    await golden('unknown-harness', await hook('unknown', '{}'));
  });
});

it('pins harness precedence and session identifiers', async () => {
  await golden('session-resolution', {
    harnesses: [
      resolveHarness(['--harness', 'cursor'], { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: 'session' }),
      resolveHarness([], { KHALA_MCP_HARNESS: 'cursor', CLAUDE_CODE_SESSION_ID: 'session' }),
      resolveHarness([], { CLAUDE_CODE_SESSION_ID: 'session' }),
      resolveHarness([], {}),
      resolveHarness(['--harness', 'unknown'], {}),
    ],
    sessions: {
      claude: resolveSessionId('claude', { threadId: 'ignored' }, { CLAUDE_CODE_SESSION_ID: 'claude-env' }),
      codexMeta: resolveSessionId('codex', { threadId: 'meta-thread' }, { CODEX_THREAD_ID: 'env-thread' }),
      codexEnv: resolveSessionId('codex', undefined, { CODEX_THREAD_ID: 'env-thread' }),
      cursorWorkspace: resolveSessionId('cursor', { threadId: 'ignored' }, { KHALA_CURSOR_WORKSPACE: workspace }),
      cursorDefault: resolveSessionId('cursor', undefined, {}),
      invalidClaude: resolveSessionId('claude', undefined, { CLAUDE_CODE_SESSION_ID: '../invalid' }),
      invalidCodex: resolveSessionId('codex', { threadId: '../invalid' }, { CODEX_THREAD_ID: 'valid' }),
    },
  });
});

it.each(harnesses)('%s waker selection is observable through the factory', async harness => {
  const notify = vi.fn(), stop = vi.fn(async () => {});
  const createWaker = vi.fn(() => ({ notify, stop }));
  const createClient = vi.fn<(options: KhalaAgentClientOptions) => ReturnType<typeof createPlaceholderClient>>(() => createPlaceholderClient());
  const client = createRealClientFactory({ XDG_STATE_HOME: root }, { createWaker, createClient })({ harness, sessionId: 'session' });
  try {
    createClient.mock.calls[0]![0].onInboxAppend?.(entry(1));
    if (harness === 'codex') expect(createWaker).toHaveBeenCalledWith({ files: sessionFiles(harness, 'session', { XDG_STATE_HOME: root }), threadId: 'session' });
  } finally { await client.close(); }
  await golden(`waker-${harness}`, {
    threads: createWaker.mock.calls.map(() => 'session'),
    notified: notify.mock.calls.length, stopped: stop.mock.calls.length,
    hasInboxCallback: typeof createClient.mock.calls[0]![0].onInboxAppend === 'function',
  });
});

it('only folderless Cursor omits persistent rejoin identity', async () => {
  const observed = [];
  for (const [harness, id] of [['claude', 'session'], ['codex', 'session'], ['cursor', cursorSessionId(workspace)], ['cursor', 'cursor-default']] as const) {
    const files = await openSessionDir(harness, id, { XDG_STATE_HOME: root });
    const client = createKhalaAgentClient({ harness, sessionId: id, env: { XDG_STATE_HOME: root } });
    let saved: { secret: string } | null;
    try {
      const status = await client.status();
      saved = await readStateFile(files.dir, 'rejoin.json');
      observed.push({ harness, sessionId: id, status, rejoin: saved === null ? null : { validSecret: validAgentRejoinSecret(saved.secret) } });
    } finally { await client.close(); }
    const join = vi.fn<typeof requestJoin>().mockRejectedValue(new Error('offline'));
    const restarted = createKhalaAgentClient({ harness, sessionId: id, env: { XDG_STATE_HOME: root },
      joinApi: { requestJoin: join, pollJoin: vi.fn(), reportReady: vi.fn() } });
    try {
      await restarted.status();
      expect(await readStateFile(files.dir, 'rejoin.json')).toEqual(saved);
      await expect(restarted.join('https://khala.example/join/abcdefgh', 'Scout')).rejects.toThrow();
      expect(join).toHaveBeenCalledWith({ link: 'https://khala.example/join/abcdefgh', harness, label: 'Scout',
        ...(saved ? { sessionId: id, rejoinSecret: saved.secret } : {}) }, {});
    } finally { await restarted.close(); }
  }
  await golden('rejoin-identity', observed);
});

async function writtenFiles(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(dir, item.name);
    if (item.isDirectory()) {
      for (const [name, text] of Object.entries(await writtenFiles(filename))) result[`${item.name}/${name}`] = text;
    } else result[item.name] = (await fs.readFile(filename, 'utf8')).replaceAll(root, '<HOME>');
  }
  return result;
}
it.each(['codex', 'cursor'])('install %s writes golden files and is idempotent', async harness => {
  const configDir = path.join(root, harness === 'codex' ? '.codex' : '.cursor');
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, 'hooks.json'), '{"hooks":{}}\n');
  await fs.writeFile(path.join(configDir, harness === 'codex' ? 'config.toml' : 'mcp.json'),
    harness === 'codex' ? 'model = "existing"\n' : '{"mcpServers":{"other":{"command":"existing"}}}\n');
  const install = async () => {
    const stdout: string[] = [], stderr: string[] = [], npm: string[][] = [];
    const code = await runInstall([harness], {
      env: { HOME: root }, home: root, platform: 'linux', node: '/opt/node',
      package: { name: 'khala-cli', version: '9.8.7' },
      npmInstall: (prefix, spec) => { npm.push([prefix.replaceAll(root, '<HOME>'), spec]); return true; },
      stdout: line => { stdout.push(line.replaceAll(root, '<HOME>')); },
      stderr: line => { stderr.push(line.replaceAll(root, '<HOME>')); },
    });
    return { code, stdout, stderr, npm, files: await writtenFiles(root) };
  };
  const first = await install();
  await golden(`install-${harness}`, first);
  expect(await install()).toEqual(first);
});

it('runCli routes every existing harness argv form unchanged', async () => {
  // Exercise the shared parser without starting a persistent MCP server or waker.
  const stdin = vi.spyOn(process, 'stdin', 'get');
  const calls: unknown[] = [];
  const main = (name: string) => async () => ({ default: (argv: readonly string[]) => { calls.push({ name, argv }); return 0; } });
  const modules: CliModules = {
    mcp: () => main('mcp'), install: () => main('install'), local: () => undefined,
    hook: name => async () => ({ default: (stdin, argv) => { calls.push({ name, stdin, argv }); return 0; } }),
  };
  const argv = [
    ...harnesses.map(harness => ['hook', 'deliver', '--harness', harness]),
    ['hook', 'claude-wake'], ['install', 'codex'], ['install', 'cursor'], ['mcp', '--harness', 'claude'],
  ];
  const codes = [];
  for (const args of argv) {
    stdin.mockReturnValue(Readable.from([Buffer.from('{}')]) as typeof process.stdin);
    codes.push(await runCli(args, modules));
  }
  await golden('cli-routing', { codes, calls });
});
