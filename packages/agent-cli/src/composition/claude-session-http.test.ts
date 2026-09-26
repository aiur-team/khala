import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BINDINGS, batch, directory, fakeServices, type FakeServices } from '../fixtures/claude.js';
import { createClaudeSessionAdapter } from './claude-session.js';
import { CLAUDE_SESSION_PATH, createClaudeSessionClient, handleClaudeSessionRequest } from './claude-session-http.js';
import { openClaudeSessionState } from './claude-session-state.js';

const processScript = fileURLToPath(new URL('../fixtures/claude-process.ts', import.meta.url));
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-http-'));
  roots.push(dir);
  return dir;
}

type Launch = Readonly<{ origin: string; credential: string; logs: string[]; server: Server }>;

/** One launch of the local server: fresh port, fresh credential, same durable state directory. */
async function launch(stateDirectory: string, services: FakeServices, credential: string): Promise<Launch> {
  const adapter = createClaudeSessionAdapter({
    authenticator: { authenticate: async presented => presented === credential ? { principalId: 'principal-a' } : null },
    sessions: directory(),
    state: await openClaudeSessionState(stateDirectory),
    services: services.services,
  });
  const logs: string[] = [];
  const server = createServer(async (request, response) => {
    logs.push(`${request.method} ${request.url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let body: unknown = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* invalid_request */ }
    const result = request.url === CLAUDE_SESSION_PATH
      ? await handleClaudeSessionRequest(adapter, { authorization: request.headers.authorization, body, readBudgetBytes: 4096 })
      : { status: 400, body: {} };
    logs.push(`status ${result.status}`);
    response.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credential, logs, server };
}

function writeDescriptor(file: string, target: Pick<Launch, 'origin' | 'credential'>): void {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ v: 1, channelId: 'channel-1', origin: target.origin, transportCapability: target.credential }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

type ProcessResult = Readonly<{ code: number | null; stdout: string; stderr: string; argv: readonly string[]; env: NodeJS.ProcessEnv }>;

function claudeProcess(descriptorPath: string, args: readonly string[], stdin = ''): Promise<ProcessResult> {
  const argv = ['--import', 'tsx', processScript, descriptorPath, ...args];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, argv, env }));
    child.stdin.end(stdin);
  });
}

function assertNoRuntimeSecrets(values: readonly unknown[], launches: readonly Launch[]): void {
  const text = JSON.stringify(values);
  for (const launched of launches) {
    expect(text).not.toContain(launched.credential);
    expect(text).not.toContain(launched.origin);
    expect(text).not.toContain(`:${new URL(launched.origin).port}`);
  }
}

describe('Claude session adapter over the loopback server', () => {
  it('retains a hook pull’s token across a server restart until the agent’s next Khala call acknowledges it', async () => {
    const root = workspace();
    const stateDirectory = path.join(root, 'server-state');
    const descriptor = path.join(root, 'active.json');
    const services = fakeServices();
    services.services(BINDINGS['s-1']);
    services.services(BINDINGS['s-2']);
    const read = services.reads.get('binding-1')!;
    read.next.push({ kind: 'batch', batch: batch('restart-token', '{"body":"first release"}') });

    const first = await launch(stateDirectory, services, 'F'.repeat(43));
    writeDescriptor(descriptor, first);
    const hook = await claudeProcess(descriptor, ['pull', '--session', 's-1']);
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain('first release');
    expect(hook.stdout).not.toContain('restart-token');
    const secondHook = await claudeProcess(descriptor, ['pull', '--session', 's-1']);
    expect(JSON.parse(secondHook.stdout)).toEqual({ ok: true, kind: 'empty' });

    // Restart: new port and credential, the same durable server-side state.
    await new Promise(resolve => first.server.close(resolve));
    const stale = await claudeProcess(descriptor, ['status', '--session', 's-1']);
    expect(stale.code).toBe(3);
    expect(JSON.parse(stale.stdout)).toEqual({ ok: false, kind: 'refused', code: 'unavailable' });

    const second = await launch(stateDirectory, services, 'S'.repeat(43));
    writeDescriptor(descriptor, { origin: second.origin, credential: first.credential });
    const rotated = await claudeProcess(descriptor, ['status', '--session', 's-1']);
    expect(JSON.parse(rotated.stdout)).toEqual({ ok: false, kind: 'refused', code: 'unauthorized' });
    writeDescriptor(descriptor, second);

    const otherSession = await claudeProcess(descriptor, ['read', '--session', 's-2']);
    const command = await claudeProcess(descriptor, ['status', '--session', 's-1']);
    const after = await claudeProcess(descriptor, ['read', '--session', 's-1']);
    expect(JSON.parse(command.stdout)).toEqual({ ok: true, kind: 'status', acknowledged: 1 });
    expect(JSON.parse(after.stdout)).toEqual({ ok: true, kind: 'empty' });

    // Neither hook pull acknowledged; the agent's call did, exactly once; nothing leaked to session two.
    expect(read.calls).toEqual([
      { bindingId: 'binding-1', maxBytes: 4096 },
      { bindingId: 'binding-1', maxBytes: 4096 },
      { bindingId: 'binding-1', maxBytes: 0, acknowledgeToken: 'restart-token' },
      { bindingId: 'binding-1', maxBytes: 4096 },
    ]);
    expect(services.reads.get('binding-2')!.calls).toEqual([{ bindingId: 'binding-2', maxBytes: 4096 }]);
    const processes = [hook, secondHook, stale, rotated, otherSession, command, after];
    assertNoRuntimeSecrets(processes.map(result => [result.stdout, result.stderr, result.argv, result.env]), [first, second]);
    assertNoRuntimeSecrets([first.logs, second.logs], [first, second]);
    expect(JSON.stringify(processes.map(result => [result.stdout, result.stderr]))).not.toContain('restart-token');
    expect(fs.readdirSync(stateDirectory)).toEqual([]);
  }, 30_000);

  it('fails closed on missing, malformed, and insecure descriptors without contacting the server', async () => {
    const root = workspace();
    const services = fakeServices();
    const launched = await launch(path.join(root, 'state'), services, 'M'.repeat(43));
    const descriptor = path.join(root, 'active.json');
    const client = createClaudeSessionClient({ descriptorPath: descriptor });

    await expect(client.read('s-1')).resolves.toEqual({ kind: 'refused', code: 'descriptor_missing' });
    fs.writeFileSync(descriptor, '{"v":1', { mode: 0o600 });
    await expect(client.pending('s-1')).resolves.toEqual({ kind: 'refused', code: 'descriptor_malformed' });
    writeDescriptor(descriptor, launched);
    fs.chmodSync(descriptor, 0o644);
    await expect(client.send('s-1', 'hello')).resolves.toEqual({ kind: 'refused', code: 'descriptor_insecure' });
    expect(launched.logs).toEqual([]);

    fs.chmodSync(descriptor, 0o600);
    await expect(client.pending('s-1')).resolves.toEqual({ kind: 'idle' });
    expect(launched.logs).toEqual([`POST ${CLAUDE_SESSION_PATH}`, 'status 200']);
  });

  it('round-trips hook boundary state over the loopback route', async () => {
    const root = workspace();
    const services = fakeServices();
    services.mode.value = 'steer';
    const launched = await launch(path.join(root, 'state'), services, 'J'.repeat(43));
    const descriptor = path.join(root, 'active.json');
    writeDescriptor(descriptor, launched);
    const client = createClaudeSessionClient({ descriptorPath: descriptor });
    await expect(client.hook('s-1')).resolves.toEqual({ kind: 'hook', effective: 'steer', watchSeconds: 3000 });
    await expect(client.hook('s-3')).resolves.toEqual({ kind: 'refused', code: 'session_not_bound' });
  });

  it('resolves a rotated descriptor on the next call of a long-lived client', async () => {
    const root = workspace();
    const services = fakeServices();
    const first = await launch(path.join(root, 'state'), services, 'G'.repeat(43));
    const second = await launch(path.join(root, 'state'), services, 'H'.repeat(43));
    const descriptor = path.join(root, 'active.json');
    const client = createClaudeSessionClient({ descriptorPath: descriptor });

    writeDescriptor(descriptor, first);
    await expect(client.pending('s-1')).resolves.toEqual({ kind: 'idle' });
    writeDescriptor(descriptor, second);
    await expect(client.pending('s-1')).resolves.toEqual({ kind: 'idle' });
    expect(first.logs).toHaveLength(2);
    expect(second.logs).toHaveLength(2);
  });

  it('fails closed within its deadline when the server accepts but never answers', async () => {
    const root = workspace();
    const silent = createServer(() => { /* never responds */ });
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
    servers.push(silent);
    const descriptor = path.join(root, 'active.json');
    writeDescriptor(descriptor, { origin: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, credential: 'T'.repeat(43) });
    const started = Date.now();
    await expect(createClaudeSessionClient({ descriptorPath: descriptor, timeoutMs: 200 }).pending('s-1'))
      .resolves.toEqual({ kind: 'refused', code: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(5_000);
    silent.closeAllConnections();
  });

  it('passes only the closed mode fields through to the caller', async () => {
    const root = workspace();
    const descriptor = path.join(root, 'active.json');
    const answers: unknown[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answers.shift()));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    writeDescriptor(descriptor, { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credential: 'U'.repeat(43) });
    const client = createClaudeSessionClient({ descriptorPath: descriptor });
    const mode = {
      kind: 'mode', requested: 'sync', effective: null, version: 2,
      support: { steer: 'unproven', sync: 'unproven', async: 'unproven' }, acknowledgement: 'batch_token_next_call',
    };
    answers.push({ ...mode, bindingId: 'binding-1', support: { ...mode.support, extra: 'x' } }, { ...mode, requested: 'loud' });
    await expect(client.mode('s-1')).resolves.toEqual(mode);
    await expect(client.mode('s-1')).resolves.toEqual({ kind: 'refused', code: 'unavailable' });
  });

  it('refuses a hook response with extra fields or out-of-range values', async () => {
    const root = workspace();
    const descriptor = path.join(root, 'active.json');
    const answers: unknown[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answers.shift()));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    writeDescriptor(descriptor, { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credential: 'V'.repeat(43) });
    const client = createClaudeSessionClient({ descriptorPath: descriptor });
    const hook = { kind: 'hook', effective: 'steer', watchSeconds: 60 };
    answers.push(
      hook,
      { ...hook, bindingId: 'binding-1' },
      { ...hook, effective: 'loud' },
      { ...hook, watchSeconds: 0 },
      { ...hook, watchSeconds: -1 },
      { ...hook, watchSeconds: 1.5 },
      { kind: 'hook', effective: 'steer' },
    );
    await expect(client.hook('s-1')).resolves.toEqual(hook);
    for (let index = 0; index < 6; index += 1) {
      await expect(client.hook('s-1')).resolves.toEqual({ kind: 'refused', code: 'unavailable' });
    }
  });

  it('decodes mode_set requests strictly before reaching the adapter', async () => {
    const services = fakeServices();
    const adapter = createClaudeSessionAdapter({
      authenticator: { authenticate: async () => ({ principalId: 'principal-a' }) },
      sessions: directory(), state: await openClaudeSessionState(path.join(workspace(), 'state')), services: services.services,
    });
    const authorization = `Bearer ${'A'.repeat(43)}`;
    const valid = {
      v: 1, op: 'mode_set', sessionId: 's-1', commandId: 'command-1', expectedVersion: 1, requested: 'steer', issuedAt: '2026-09-25T00:00:00Z',
    };
    await expect(handleClaudeSessionRequest(adapter, { authorization, body: valid, readBudgetBytes: 1 })).resolves.toEqual({
      status: 200, body: { kind: 'mode_set', outcome: 'applied', requested: 'steer', effective: null, version: 2 },
    });
    for (const invalid of [
      { ...valid, requested: 'loud' }, { ...valid, expectedVersion: -1 }, { ...valid, expectedVersion: 1.5 },
      { ...valid, issuedAt: 'yesterday' }, { ...valid, commandId: '' }, { ...valid, ackBatchToken: 'x' },
    ]) {
      await expect(handleClaudeSessionRequest(adapter, { authorization, body: invalid, readBudgetBytes: 1 }))
        .resolves.toEqual({ status: 400, body: { kind: 'refused', code: 'invalid_request' } });
    }
    expect(services.modeSets).toEqual([{ bindingId: 'binding-1' }]);
  });

  it('rejects requests without a well-formed bearer credential', async () => {
    const services = fakeServices();
    const adapter = createClaudeSessionAdapter({
      authenticator: { authenticate: async () => ({ principalId: 'principal-a' }) },
      sessions: directory(), state: await openClaudeSessionState(path.join(workspace(), 'state')), services: services.services,
    });
    for (const authorization of [undefined, 'Basic abc', `Bearer ${'x'.repeat(10)}`]) {
      await expect(handleClaudeSessionRequest(adapter, { authorization, body: { v: 1, op: 'read', sessionId: 's-1' }, readBudgetBytes: 1 }))
        .resolves.toEqual({ status: 401, body: { kind: 'refused', code: 'unauthorized' } });
    }
    await expect(handleClaudeSessionRequest(adapter, {
      authorization: `Bearer ${'A'.repeat(43)}`, body: { v: 1, op: 'read', sessionId: 's-1', ackBatchToken: 'x' }, readBudgetBytes: 1,
    })).resolves.toEqual({ status: 400, body: { kind: 'refused', code: 'invalid_request' } });
    expect(services.reads.size).toBe(0);
  });
});
