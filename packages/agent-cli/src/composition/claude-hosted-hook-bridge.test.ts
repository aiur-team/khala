import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { runHook } from '../../../claude-plugin/hooks/lib/runtime.mjs';
import { fakeKhala, hookDeps } from '../../../claude-plugin/src/fakes';
import { claudeHostedHookPaths, startClaudeHostedHookBridge, type ClaudeHostedBoundary } from './claude-hosted-hook-bridge';

const root = process.env.TMPDIR ?? tmpdir();
const frame = '<khala-channel-batch-v1>\n{"body":"owner selected release"}\n</khala-channel-batch-v1>';
const binding = (generation: number): SessionBinding => ({
  v: 1, bindingId: 'binding-717', generation, ownerId: 'owner-1', agentParticipantId: 'agent-1',
  deviceId: 'device-1', harness: 'proof-key', sessionId: 'agent-session',
} as SessionBinding);

function fixture() {
  const sessionId = randomUUID();
  let held = binding(1);
  let mode: 'steer' | 'sync' | null = 'steer';
  let paused = false;
  const acknowledgements: string[] = [];
  const pulls: ClaudeHostedBoundary[] = [];
  const port = {
    async pull(boundary: ClaudeHostedBoundary) {
      pulls.push(boundary);
      return { boundary, binding: held, token: 'private-token', releaseIds: ['release-717'], frame };
    },
    async current(delivery: { binding: SessionBinding; boundary: ClaudeHostedBoundary }) {
      return !paused && delivery.binding.bindingId === held.bindingId
        && delivery.binding.generation === held.generation
        && mode === (delivery.boundary === 'post_tool_use' ? 'steer' : 'sync');
    },
    async acknowledge(delivery: { token: string }) { acknowledgements.push(delivery.token); },
  };
  const deps = {
    hostedRoot: root, stateRoot: root, terminalKeyPath: `${root}/no-key`,
    bound: async () => false, khala: async () => { throw new Error('internal route must be silent'); },
    sleep: async () => {}, now: () => Date.now(), nonce: () => 'unused', parentAlive: () => true,
  };
  const hook = (role: 'post-tool-use' | 'stop') => runHook(role,
    JSON.stringify({ hook_event_name: role === 'stop' ? 'Stop' : 'PostToolUse', session_id: sessionId }), deps);
  return { sessionId, port, hook, pulls, acknowledgements,
    mode: (value: 'steer' | 'sync' | null) => { mode = value; },
    pause: () => { paused = true; }, resume: () => { paused = false; },
    generation: (value: number) => { held = binding(value); },
    bindingId: (value: string) => { held = { ...held, bindingId: value as SessionBinding['bindingId'] }; } };
}

describe('Claude hosted hook receipt bridge', () => {
  it('keeps the exact internal hook path when a hosted descriptor is empty or refuses', async () => {
    const f = fixture();
    const internal = fakeKhala();
    internal.bind(f.sessionId, 'steer');
    internal.release(f.sessionId, 'internal after hosted empty');
    const { deps } = hookDeps(internal.khala, internal.engaged);
    const hookDepsWithHosted = { ...deps, hostedRoot: root };
    const postTool = () => runHook('post-tool-use',
      JSON.stringify({ hook_event_name: 'PostToolUse', session_id: f.sessionId }), hookDepsWithHosted);
    const bridge = await startClaudeHostedHookBridge({ root, sessionId: f.sessionId,
      port: { ...f.port, pull: async () => null } });
    const descriptorPath = claudeHostedHookPaths(root, f.sessionId).descriptor;
    const originalDescriptor = await readFile(descriptorPath, 'utf8');
    try {
      expect((await postTool()).stdout).toContain('internal after hosted empty');
      expect(internal.ops(f.sessionId)).toEqual(['hook', 'pull']);

      internal.agentCall(f.sessionId);
      internal.release(f.sessionId, 'internal after hosted refusal');
      const descriptor = JSON.parse(originalDescriptor) as { secret: string };
      descriptor.secret = 'A'.repeat(43);
      await writeFile(descriptorPath, JSON.stringify(descriptor));
      expect((await postTool()).stdout).toContain('internal after hosted refusal');
      expect(internal.ops(f.sessionId)).toEqual(['hook', 'pull', 'hook', 'pull']);
      internal.agentCall(f.sessionId);
      internal.bind(f.sessionId, 'sync');
      internal.release(f.sessionId, 'internal at Stop');
      const stopped = await runHook('stop',
        JSON.stringify({ hook_event_name: 'Stop', session_id: f.sessionId }), hookDepsWithHosted);
      expect(JSON.parse(stopped.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('internal at Stop') });
      expect((await runHook('post-tool-use',
        JSON.stringify({ hook_event_name: 'PostToolUse', session_id: randomUUID() }), hookDepsWithHosted)).stdout).toBe('');
    } finally {
      await writeFile(descriptorPath, originalDescriptor);
      await bridge.close();
    }
  });

  it('delivers Steer at the tool boundary and commits only after the exact later call', async () => {
    const f = fixture();
    const bridge = await startClaudeHostedHookBridge({ root, sessionId: f.sessionId, port: f.port });
    try {
      const result = await f.hook('post-tool-use');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('owner selected release');
      const nonce = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(result.stdout)?.[1];
      expect(nonce).toBeDefined();
      expect(f.acknowledgements).toEqual([]);
      expect(await bridge.acknowledge('A'.repeat(32))).toBe('stale');
      expect(await bridge.acknowledge(nonce!)).toEqual({ kind: 'acknowledged', boundary: 'post_tool_use',
        sessionFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/u),
        bindingId: 'binding-717', generation: 1, releaseIds: ['release-717'] });
      expect(f.acknowledgements).toEqual(['private-token']);
      expect(await bridge.acknowledge(nonce!)).toBe('stale');
      expect(f.pulls).toEqual(['post_tool_use']);
    } finally { await bridge.close(); }
  });

  it('delivers Sync at Stop and invalidates receipts on pause, generation or binding change', async () => {
    const f = fixture(); f.mode('sync');
    const bridge = await startClaudeHostedHookBridge({ root, sessionId: f.sessionId, port: f.port });
    try {
      expect((await f.hook('post-tool-use')).stdout).toBe('');
      const stopped = await f.hook('stop');
      expect(JSON.parse(stopped.stdout)).toMatchObject({ decision: 'block' });
      const nonce = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(stopped.stdout)?.[1];
      expect(nonce).toBeDefined();
      f.pause();
      expect(await bridge.acknowledge(nonce!)).toBe('stale');
      f.resume();
      const again = await f.hook('stop');
      const next = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(again.stdout)?.[1];
      expect(next).toBeDefined();
      f.generation(2);
      expect(await bridge.acknowledge(next!)).toBe('stale');
      const afterGeneration = await f.hook('stop');
      const last = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(afterGeneration.stdout)?.[1];
      expect(last).toBeDefined();
      f.bindingId('other-binding');
      expect(await bridge.acknowledge(last!)).toBe('stale');
      expect(f.acknowledgements).toEqual([]);
    } finally { await bridge.close(); }
  });

  it('refuses wrong socket credentials and loses stale hook evidence after restart', async () => {
    const f = fixture();
    const bridge = await startClaudeHostedHookBridge({ root, sessionId: f.sessionId, port: f.port });
    await expect(startClaudeHostedHookBridge({ root, sessionId: f.sessionId, port: f.port }))
      .rejects.toThrow('active_hook_bridge_exists');
    const descriptor = JSON.parse(await readFile(claudeHostedHookPaths(root, f.sessionId).descriptor, 'utf8')) as { socketPath: string; secret: string };
    const wrong = await new Promise<string>(resolve => {
      const socket = createConnection(descriptor.socketPath);
      let output = '';
      socket.on('connect', () => socket.write(JSON.stringify({ v: 1, sessionId: f.sessionId,
        boundary: 'post_tool_use', secret: 'A'.repeat(43) }) + '\n'));
      socket.on('data', chunk => { output += chunk.toString(); if (output.includes('\n')) { resolve(output); socket.destroy(); } });
    });
    expect(wrong).toContain('unsupported');
    const wrongSession = await new Promise<string>(resolve => {
      const socket = createConnection(descriptor.socketPath);
      let output = '';
      socket.on('connect', () => socket.write(JSON.stringify({ v: 1, sessionId: randomUUID(),
        boundary: 'post_tool_use', secret: descriptor.secret }) + '\n'));
      socket.on('data', chunk => { output += chunk.toString(); if (output.includes('\n')) { resolve(output); socket.destroy(); } });
    });
    expect(wrongSession).toContain('unsupported');
    const first = await f.hook('post-tool-use');
    const nonce = /Khala hosted hook receipt: ([A-Za-z0-9_-]{32})/u.exec(first.stdout)?.[1];
    await bridge.close();
    expect((await f.hook('post-tool-use')).stdout).toBe('');
    const resumed = await startClaudeHostedHookBridge({ root, sessionId: f.sessionId, port: f.port });
    try {
      expect(await resumed.acknowledge(nonce!)).toBe('stale');
      expect((await f.hook('post-tool-use')).stdout).toContain('owner selected release');
      expect(f.acknowledgements).toEqual([]);
    } finally { await resumed.close(); }
  });
});
