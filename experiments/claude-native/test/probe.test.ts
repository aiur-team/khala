import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertDesignatedTarget,
  buildSocketFrame,
  runSocketChild,
  type NativeTarget,
  type RuntimeEvidence,
} from '../probe.ts';
import { buildHostedArgs, buildStreamUserMessage, classifyHostedEvent } from '../hosted.ts';

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

test('pins the hosted resume route to the documented streaming flags', () => {
  assert.deepEqual(buildHostedArgs(TARGET.sessionId), [
    '-p',
    '--resume', TARGET.sessionId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--include-hook-events',
    '--permission-prompts', 'none',
  ]);
});

test('writes hosted payloads as one stream-json user line', () => {
  assert.equal(
    buildStreamUserMessage('released-nonce-delta'),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'released-nonce-delta' }, parent_tool_use_id: null, origin: { kind: 'human' } })}\n`,
  );
});

test('separates replay acknowledgement, consumption, hook and completion levels', () => {
  assert.equal(classifyHostedEvent({ type: 'user', message: { role: 'user', content: 'nonce' } }, 'nonce'), 'user_replayed');
  assert.equal(classifyHostedEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'nonce seen' }] } }, 'nonce'), 'context_consumed');
  assert.equal(classifyHostedEvent({ type: 'system', subtype: 'hook_started' }, 'nonce'), 'hook_event');
  assert.equal(classifyHostedEvent({ type: 'result' }, 'nonce'), 'completed');
  assert.equal(classifyHostedEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'other' }] } }, 'nonce'), null);
});
