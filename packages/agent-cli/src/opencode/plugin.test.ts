import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BindingId, SessionBinding } from '@khala/contracts/delivery/index';
import { FakeControls, FakeSend, FakeWakes } from './fakes.js';
import entry from './index.js';
import {
  type HeldBatchPort, type OpenCodePluginClient, createKhalaOpenCodeServer, createOpenCodeSessionPort,
  openCodeVersionFromExecPath,
} from './plugin.js';
import { memoryOpenCodeBridgeStore } from './store.js';

const binding = (generation: number, harness = 'opencode') => ({
  v: 1, bindingId: 'binding-oc' as BindingId, ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness, sessionId: 'ses_A', generation,
}) as SessionBinding;

type Call = { method: string; options: unknown };

function sdkClient(overrides: Partial<Record<keyof OpenCodePluginClient['session'], (options: unknown) => unknown>> = {}) {
  const calls: Call[] = [];
  const method = (name: keyof OpenCodePluginClient['session'], fallback: unknown) =>
    async (options: unknown) => {
      calls.push({ method: name, options });
      return (overrides[name]?.(options) ?? fallback) as never;
    };
  const client: OpenCodePluginClient = {
    session: {
      status: method('status', { data: {} }),
      get: method('get', { data: { id: 'ses_A' } }),
      messages: method('messages', { data: [] }),
      promptAsync: method('promptAsync', { data: undefined }),
    },
  };
  return { client, calls };
}

describe('@aiur/khala/opencode entry', () => {
  it('default-exports an OpenCode v1 plugin module, so OpenCode ignores the named exports', () => {
    expect(Object.keys(entry).sort()).toEqual(['id', 'server']);
    expect(entry.id).toBe('khala');
    expect(typeof entry.server).toBe('function');
  });

  it('the shipped entry binds nothing and delivers nothing for a session that holds no grant', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-opencode-entry-'));
    vi.stubEnv('XDG_STATE_HOME', state);
    const { client, calls } = sdkClient();
    const hooks = await entry.server({ client, directory: '/work/project' });
    vi.unstubAllEnvs();
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_A' });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_A' } } });
    const messages = [{ info: { id: 'msg_1', sessionID: 'ses_A', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }];
    await hooks['experimental.chat.messages.transform']({}, { messages });
    expect(messages).toHaveLength(1);
    expect(await hooks.tool.khala_read.execute({}, { sessionID: 'ses_A' })).toBe(
      JSON.stringify({ kind: 'refused', code: 'not_connected' }),
    );
    expect(calls).toEqual([]);
    await hooks.dispose();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('registers only the bridge hooks: never `permission.ask`, so tools follow OpenCode policy', async () => {
    const { client } = sdkClient();
    const hooks = await entry.server({ client, directory: '/work/project' });
    expect(Object.keys(hooks).sort()).toEqual(
      ['dispose', 'event', 'experimental.chat.messages.transform', 'tool', 'tool.execute.after'],
    );
    expect(Object.keys(hooks.tool).sort()).toEqual(['khala_read', 'khala_send']);
    const send = z.object(hooks.tool.khala_send.args);
    expect(send.safeParse({}).success).toBe(false);
    expect(send.safeParse({ message: 'hi', ackBatchToken: 't' }).success).toBe(true);
    expect(z.object(hooks.tool.khala_read.args).safeParse({}).success).toBe(true);
  });
});

describe('OpenCode version and session client', () => {
  const noFiles = () => null;
  const packages = (files: Record<string, unknown>) => (file: string) =>
    Object.hasOwn(files, file) ? JSON.stringify(files[file]) : null;

  it('reads the version from the executable path the way the retained proof did', () => {
    expect(openCodeVersionFromExecPath('/home/u/.local/share/mise/installs/opencode/1.17.10/opencode', noFiles)).toBe('1.17.10');
    expect(openCodeVersionFromExecPath('/usr/bin/opencode', noFiles)).toBeNull();
  });

  it('reads a plain npm install from its package metadata, as `opencode --version` reports it', () => {
    const modules = '/home/u/.local/lib/node_modules';
    const read = packages({
      [`${modules}/opencode-ai/package.json`]: { name: 'opencode-ai', version: '1.17.10' },
      [`${modules}/opencode-ai/node_modules/opencode-linux-x64/package.json`]: { name: 'opencode-linux-x64', version: '1.17.10' },
    });
    // `postinstall` places the binary in `opencode-ai/bin`; without it the platform package's runs.
    expect(openCodeVersionFromExecPath(`${modules}/opencode-ai/bin/opencode.exe`, read)).toBe('1.17.10');
    expect(openCodeVersionFromExecPath(`${modules}/opencode-ai/node_modules/opencode-linux-x64/bin/opencode`, read)).toBe('1.17.10');
    expect(openCodeVersionFromExecPath('C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe', packages({
      'C:\\npm\\node_modules\\opencode-ai\\package.json': { name: 'opencode-ai', version: '1.17.10' },
    }))).toBe('1.17.10');
  });

  it('keeps an unparseable or foreign version unknown', () => {
    const exec = '/lib/node_modules/opencode-ai/bin/opencode.exe';
    const at = (metadata: unknown) => openCodeVersionFromExecPath(exec, () => JSON.stringify(metadata));
    expect(at({ name: 'opencode-ai', version: '1.17' })).toBeNull();
    expect(at({ name: 'opencode-ai', version: 'latest' })).toBeNull();
    expect(at({ name: 'opencode-ai' })).toBeNull();
    expect(at(null)).toBeNull();
    expect(openCodeVersionFromExecPath(exec, () => '{not json')).toBeNull();
    // Another package's bin directory says nothing about OpenCode.
    expect(openCodeVersionFromExecPath('/lib/node_modules/bun/bin/bun', () => JSON.stringify({ name: 'bun', version: '1.17.10' }))).toBeNull();
  });

  it('reads the real npm layout from disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-opencode-npm-'));
    try {
      const pkg = path.join(root, 'node_modules', 'opencode-ai');
      fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.17.10' }));
      expect(openCodeVersionFromExecPath(path.join(pkg, 'bin', 'opencode.exe'))).toBe('1.17.10');
      expect(openCodeVersionFromExecPath(path.join(root, 'bin', 'opencode'))).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('addresses every call to the bound session and directory', async () => {
    const { client, calls } = sdkClient({ status: () => ({ data: { ses_A: { type: 'busy' } } }) });
    const port = createOpenCodeSessionPort(client, '/work/project');
    expect(await port.status('ses_A')).toBe('busy');
    expect(await port.promptAsync({ sessionID: 'ses_A', text: 'env', model: { providerID: 'p', modelID: 'm' } })).toBe('accepted');
    expect(calls[1]).toEqual({
      method: 'promptAsync',
      options: {
        path: { id: 'ses_A' }, query: { directory: '/work/project' },
        body: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'env' }] },
      },
    });
  });

  it('maps an absent status to idle only while the session exists', async () => {
    const present = createOpenCodeSessionPort(sdkClient().client, '/w');
    expect(await present.status('ses_A')).toBe('idle');
    const deleted = createOpenCodeSessionPort(
      sdkClient({ get: () => ({ error: { name: 'NotFound' }, response: { status: 404 } }) }).client, '/w',
    );
    expect(await deleted.status('ses_A')).toBe('missing');
  });

  it('separates a definite refusal from an unknown prompt outcome', async () => {
    const model = { providerID: 'p', modelID: 'm' };
    const rejected = createOpenCodeSessionPort(
      sdkClient({ promptAsync: () => ({ error: { name: 'BadRequest' }, response: { status: 400 } }) }).client, '/w',
    );
    expect(await rejected.promptAsync({ sessionID: 'ses_A', text: 'x', model })).toBe('rejected');
    const unknown = createOpenCodeSessionPort(
      sdkClient({ promptAsync: () => ({ error: { name: 'Internal' }, response: { status: 500 } }) }).client, '/w',
    );
    await expect(unknown.promptAsync({ sessionID: 'ses_A', text: 'x', model })).rejects.toThrow();
  });

  it('reduces stored messages to identity, model and text parts', async () => {
    const port = createOpenCodeSessionPort(sdkClient({
      messages: () => ({
        data: [{
          info: { id: 'msg_1', sessionID: 'ses_A', role: 'user', model: { providerID: 'p', modelID: 'm' } },
          parts: [{ type: 'text', text: 'hello' }, { type: 'file', url: 'x' }],
        }],
      }),
    }).client, '/w');
    expect(await port.messages('ses_A')).toEqual([
      { id: 'msg_1', sessionID: 'ses_A', role: 'user', model: { providerID: 'p', modelID: 'm' }, texts: ['hello'] },
    ]);
  });
});

describe('OpenCode plugin composition', () => {
  function composed(initial: SessionBinding | null) {
    const controls = new FakeControls(binding(3), 'async');
    controls.set({ binding: initial });
    const opened: number[] = [];
    const released: number[] = [];
    const openBatch = vi.fn(async (held: SessionBinding): Promise<HeldBatchPort> => {
      opened.push(held.generation);
      const wakes = new FakeWakes();
      return {
        readBatch: async () => null,
        nextWake: () => wakes.nextWake(),
        release: async () => { wakes.release(); released.push(held.generation); },
      };
    });
    const server = createKhalaOpenCodeServer({
      controls, send: new FakeSend(), openBatch, version: '1.17.10',
      openStore: async held => memoryOpenCodeBridgeStore(held.bindingId, held.generation),
    });
    return { controls, opened, released, server };
  }

  it('opens one bridge per binding generation and releases it on a new generation or Stop', async () => {
    const { controls, opened, released, server } = composed(binding(3));
    const hooks = await server({ client: sdkClient().client, directory: '/w' });
    await Promise.all([
      hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_A' }),
      hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_A' }),
    ]);
    expect(opened).toEqual([3]);
    controls.set({ binding: binding(4) });
    expect(await hooks.tool.khala_read.execute({}, { sessionID: 'ses_A' })).toBe(JSON.stringify({ kind: 'empty' }));
    expect(opened).toEqual([3, 4]);
    expect(released).toEqual([3]);
    controls.set({ binding: null });
    expect(await hooks.tool.khala_read.execute({}, { sessionID: 'ses_A' })).toContain('not_connected');
    expect(released).toEqual([3, 4]);
  });

  it('does not bind a binding held for another harness', async () => {
    const { opened, server } = composed(binding(3, 'codex'));
    const hooks = await server({ client: sdkClient().client, directory: '/w' });
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_A' });
    expect(opened).toEqual([]);
  });
});
