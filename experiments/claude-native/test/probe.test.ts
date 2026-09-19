import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertDesignatedTarget,
  buildSocketFrame,
  runSocketChild,
  type NativeTarget,
  type RuntimeEvidence,
} from '../probe.ts';
import {
  buildHostedArgs,
  buildHostedEnv,
  buildStreamUserMessage,
  classifyHostedEvent,
  HostedEventClassifier,
  HostedSession,
} from '../hosted.ts';

const TARGET: NativeTarget = {
  sessionId: '00000000-0000-4000-8000-000000000000',
  workdir: '/synthetic/target',
  sessionPid: 1234,
};

test('refuses every session/workdir/pid tuple not explicitly designated', () => {
  assert.throws(
    () => assertDesignatedTarget({ ...TARGET, sessionId: '11111111-1111-4111-8111-111111111111' }, [TARGET]),
    /not a designated disposable target/,
  );
  assert.throws(() => assertDesignatedTarget({ ...TARGET, workdir: '/other' }, [TARGET]), /not a designated disposable target/);
  assert.throws(() => assertDesignatedTarget({ ...TARGET, sessionPid: 4321 }, [TARGET]), /not a designated disposable target/);
});

test('builds the installed CLI documented auth and user JSONL bytes exactly', () => {
  assert.equal(
    buildSocketFrame('a'.repeat(64), 'released-nonce-alpha'),
    `${JSON.stringify({ type: 'auth', token: 'a'.repeat(64) })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: 'released-nonce-alpha' } })}\n`,
  );
  assert.throws(() => buildSocketFrame('not-a-token', 'released-nonce-alpha'), /token/);
  assert.throws(() => buildSocketFrame('a'.repeat(64), ''), /payload/);
  assert.throws(() => buildSocketFrame('a'.repeat(64), 'x'.repeat(65_537)), /payload/);
});

test('writes one frame to the verified designated socket without exposing payload or token', async () => {
  const scratch = await mkdtemp('/tmp/khala-claude-native-test-');
  const socketPath = join(scratch, 'inbox.sock');
  const received: Buffer[] = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', chunk => received.push(chunk));
    socket.on('end', () => socket.end());
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  const token = 'b'.repeat(64);
  const payload = 'released-nonce-private';
  const runtime: RuntimeEvidence = {
    cwd: TARGET.workdir,
    socketPath,
    token,
    registry: { sessionId: TARGET.sessionId, cwd: TARGET.workdir, messagingSocketPath: socketPath, pid: TARGET.sessionPid },
    ancestorPids: [TARGET.sessionPid],
  };
  try {
    const result = await runSocketChild(
      { target: TARGET, payload, deadlineMs: 2_000 },
      { allowedTargets: [TARGET], runtime: async () => runtime },
    );
    assert.equal(result.transportWritten, true);
    assert.equal(result.outcome, 'transport_written');
    assert.equal(result.responseBytes, 0);
    assert.match(result.frameSha256, /^sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(payload));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.equal(Buffer.concat(received).toString(), buildSocketFrame(token, payload));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test('reports outcome_unknown instead of retryable failure when no receipt follows the write', async () => {
  const scratch = await mkdtemp('/tmp/khala-claude-native-drop-test-');
  const socketPath = join(scratch, 'inbox.sock');
  let accepted: import('node:net').Socket | undefined;
  const server = createServer({ allowHalfOpen: true }, socket => {
    accepted = socket;
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  const runtime: RuntimeEvidence = {
    cwd: TARGET.workdir,
    socketPath,
    token: 'e'.repeat(64),
    registry: { sessionId: TARGET.sessionId, cwd: TARGET.workdir, messagingSocketPath: socketPath, pid: TARGET.sessionPid },
    ancestorPids: [TARGET.sessionPid],
  };
  try {
    const result = await runSocketChild(
      { target: TARGET, payload: 'released-nonce-drop', deadlineMs: 150 },
      { allowedTargets: [TARGET], runtime: async () => runtime },
    );
    assert.equal(result.transportWritten, true);
    assert.equal(result.outcome, 'outcome_unknown');
  } finally {
    accepted?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test('rejects a deadline that expires before a socket write begins', async () => {
  const runtime: RuntimeEvidence = {
    cwd: TARGET.workdir,
    socketPath: '/synthetic/pending.sock',
    token: 'f'.repeat(64),
    registry: {
      sessionId: TARGET.sessionId,
      cwd: TARGET.workdir,
      messagingSocketPath: '/synthetic/pending.sock',
      pid: TARGET.sessionPid,
    },
    ancestorPids: [TARGET.sessionPid],
  };
  const pendingSocket = new Socket();

  await assert.rejects(
    runSocketChild(
      { target: TARGET, payload: 'released-nonce-pending', deadlineMs: 100 },
      {
        allowedTargets: [TARGET],
        runtime: async () => runtime,
        socketFactory: () => pendingSocket,
      },
    ),
    /before the frame was written/,
  );
});

test('reports outcome_unknown when the socket fails after write starts but before its callback', async () => {
  const runtime: RuntimeEvidence = {
    cwd: TARGET.workdir,
    socketPath: '/synthetic/reset.sock',
    token: '1'.repeat(64),
    registry: {
      sessionId: TARGET.sessionId,
      cwd: TARGET.workdir,
      messagingSocketPath: '/synthetic/reset.sock',
      pid: TARGET.sessionPid,
    },
    ancestorPids: [TARGET.sessionPid],
  };
  const resetSocket = new Socket();
  Object.defineProperty(resetSocket, 'end', {
    value: () => {
      queueMicrotask(() => resetSocket.emit('error', new Error('synthetic reset')));
      return resetSocket;
    },
  });

  const resultPromise = runSocketChild(
    { target: TARGET, payload: 'released-nonce-reset', deadlineMs: 1_000 },
    {
      allowedTargets: [TARGET],
      runtime: async () => runtime,
      socketFactory: () => {
        queueMicrotask(() => resetSocket.emit('connect'));
        return resetSocket;
      },
    },
  );

  const result = await resultPromise;
  assert.equal(result.transportWritten, false);
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.responseTimedOut, false);
});

test('refuses a token/socket from a different session registry before connecting', async () => {
  const runtime: RuntimeEvidence = {
    cwd: TARGET.workdir,
    socketPath: '/tmp/wrong.sock',
    token: 'c'.repeat(64),
    registry: { sessionId: '11111111-1111-4111-8111-111111111111', cwd: TARGET.workdir, messagingSocketPath: '/tmp/wrong.sock', pid: TARGET.sessionPid },
    ancestorPids: [TARGET.sessionPid],
  };
  await assert.rejects(
    runSocketChild(
      { target: TARGET, payload: 'released-nonce-beta', deadlineMs: 1_000 },
      { allowedTargets: [TARGET], runtime: async () => runtime },
    ),
    /registry identity/,
  );
});

test('refuses when the designated session is not an ancestor of the child', async () => {
  const runtime: RuntimeEvidence = {
    cwd: TARGET.workdir,
    socketPath: '/tmp/designated.sock',
    token: 'd'.repeat(64),
    registry: { sessionId: TARGET.sessionId, cwd: TARGET.workdir, messagingSocketPath: '/tmp/designated.sock', pid: TARGET.sessionPid },
    ancestorPids: [9999],
  };
  await assert.rejects(
    runSocketChild(
      { target: TARGET, payload: 'released-nonce-gamma', deadlineMs: 1_000 },
      { allowedTargets: [TARGET], runtime: async () => runtime },
    ),
    /not a child/,
  );
});

test('pins the hosted new and resume routes to the documented streaming flags', () => {
  assert.deepEqual(buildHostedArgs(TARGET.sessionId), [
    '-p',
    '--resume', TARGET.sessionId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--include-hook-events',
    '--permission-prompts', 'none',
    '--verbose',
  ]);
  assert.deepEqual(buildHostedArgs(TARGET.sessionId, 'new'), [
    '-p',
    '--session-id', TARGET.sessionId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--include-hook-events',
    '--permission-prompts', 'none',
    '--verbose',
  ]);
});

test('writes hosted payloads as one stream-json user line', () => {
  assert.equal(
    buildStreamUserMessage('released-nonce-delta'),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'released-nonce-delta' }, parent_tool_use_id: null, origin: { kind: 'human' } })}\n`,
  );
});

test('enforces hosted payload bounds in bytes', () => {
  assert.doesNotThrow(() => buildStreamUserMessage('x'.repeat(65_536)));
  assert.throws(() => buildStreamUserMessage(''), /payload must be 1-65536 bytes/);
  assert.throws(() => buildStreamUserMessage('x'.repeat(65_537)), /payload must be 1-65536 bytes/);
  assert.throws(() => buildStreamUserMessage('\u00e9'.repeat(32_769)), /payload must be 1-65536 bytes/);
});

test('separates replay acknowledgement, consumption, hook and completion levels', () => {
  assert.equal(classifyHostedEvent({ type: 'user', message: { role: 'user', content: 'nonce' } }, 'nonce'), 'user_replayed');
  assert.equal(classifyHostedEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'nonce seen' }] } }, 'nonce'), 'context_consumed');
  assert.equal(classifyHostedEvent({ type: 'system', subtype: 'hook_started' }, 'nonce'), 'hook_event');
  assert.equal(classifyHostedEvent({ type: 'result' }, 'nonce'), null);
  assert.equal(classifyHostedEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'other' }] } }, 'nonce'), null);
});

test('only attributes completion after nonce-specific consumption', () => {
  const classifier = new HostedEventClassifier('target-nonce');
  assert.equal(classifier.classify({ type: 'assistant', message: { content: [{ type: 'text', text: 'other work' }] } }), null);
  assert.equal(classifier.classify({ type: 'result', result: 'unrelated completion' }), null);
  assert.equal(
    classifier.classify({ type: 'assistant', message: { content: [{ type: 'text', text: 'target-nonce consumed' }] } }),
    'context_consumed',
  );
  assert.equal(classifier.classify({ type: 'result', result: 'other completion after target consumption' }), null);
  assert.equal(classifier.classify({ type: 'result', result: 'target-nonce completion' }), 'completed');
  assert.equal(classifier.classify({ type: 'result', result: 'later unrelated completion' }), null);
});

test('passes only provider and runtime essentials to hosted children', () => {
  const env = buildHostedEnv({
    PATH: '/bin',
    HOME: '/home/test',
    XDG_CONFIG_HOME: '/home/test/.config',
    LANG: 'en_US.UTF-8',
    HTTPS_PROXY: 'https://proxy.test',
    ANTHROPIC_API_KEY: 'provider-secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    AWS_ACCESS_KEY_ID: 'bedrock-provider',
    GOOGLE_APPLICATION_CREDENTIALS: '/provider/vertex.json',
    GITHUB_TOKEN: 'github-secret',
    GH_TOKEN: 'gh-secret',
    AIUR_GITHUB_CREDENTIAL_FILE: '/host/github-token',
    AIUR_DASHBOARD_TOKEN: 'dashboard-secret',
    AIUR_WEBHOOK_SECRET: 'webhook-secret',
    CLAUDE_CODE_MESSAGING_TOKEN: 'messaging-secret',
    CLAUDE_CODE_MESSAGING_SOCKET: '/run/host-messaging.sock',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/home/test',
    XDG_CONFIG_HOME: '/home/test/.config',
    LANG: 'en_US.UTF-8',
    HTTPS_PROXY: 'https://proxy.test',
    ANTHROPIC_API_KEY: 'provider-secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    AWS_ACCESS_KEY_ID: 'bedrock-provider',
    GOOGLE_APPLICATION_CREDENTIALS: '/provider/vertex.json',
  });
});

test('preserves the custom binary slot and settles waits when the child exits', async () => {
  const session = new HostedSession(TARGET.sessionId, process.cwd(), '/usr/bin/true');
  assert.equal(await session.waitFor(() => false, 5_000), null);
  assert.equal(await session.close(), 0);
});

test('close remains settled after an abort signal exit', async () => {
  const scratch = await mkdtemp('/tmp/khala-hosted-abort-test-');
  const binary = join(scratch, 'wait-for-signal');
  await writeFile(binary, '#!/bin/sh\nwhile :; do sleep 1; done\n');
  await chmod(binary, 0o700);
  const session = new HostedSession(TARGET.sessionId, scratch, binary);
  try {
    await once(session.child, 'spawn');
    const exited = once(session.child, 'exit');
    session.abort();
    await exited;
    assert.equal(await session.close(), null);
    assert.equal(await session.waitFor(() => true, 5_000), null);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
