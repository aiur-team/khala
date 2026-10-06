import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { qwen, qwenCodec } from './qwen';
import { filesForDir } from '../state';
import { confirmWakeText, readWakeState, recordAttempt, settleAttempts } from '../wake/shared/nonce';

it('uses nested Claude envelopes and ignores background subagents', () => {
  const input = { session_id: 's', hook_event_name: 'PostToolUse' };
  expect(qwenCodec.parse(JSON.stringify(input))).toMatchObject({ event: 'tool', sessionId: 's' });
  expect(qwenCodec.parse(JSON.stringify({ ...input, agent_id: 'memory' }))).toBeNull();
  expect(JSON.parse(qwenCodec.render('tool', 'frame'))).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'frame' } });
  expect(JSON.parse(qwenCodec.render('stop', 'frame'))).toEqual({ decision: 'block', reason: 'frame' });
});

it('keeps a socket nonce across tool activity and verifies only a delivered notification at Stop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-hook-'));
  const transcript = path.join(root, 'transcript.jsonl');
  const files = filesForDir(root);
  const line = 'Khala: channel messages are waiting. Continue. (k-12345678)';
  try {
    await recordAttempt(root, { nonce: '12345678', driver: 'socket', at: 1, deadline: 100, verification: 'transcript' });
    expect(await settleAttempts(root, { now: 2, activity: { state: 'busy', updatedAt: 2 }, promptText: '' })).toEqual([]);
    await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', message: { parts: [{ text: line }] } }) + '\n');
    const stdin = JSON.stringify({ session_id: 's', hook_event_name: 'Stop', transcript_path: transcript });
    await qwen.verifyWake!(stdin, files, 3);
    expect(await readWakeState(root)).toEqual({});
    await fs.appendFile(transcript, JSON.stringify({ type: 'user', provenance: 'system', subtype: 'notification', deliveredTurn: true,
      message: { role: 'user', parts: [{ text: line }] } }) + '\n');
    await qwen.verifyWake!(stdin, files, 4);
    expect(await readWakeState(root)).toEqual({ socket: { failures: 0 } });
    await recordAttempt(root, { nonce: '87654321', driver: 'socket', at: 10, deadline: 20, verification: 'transcript' });
    await confirmWakeText(root, 'socket', '(k-87654321)', 21);
    expect(await settleAttempts(root, { now: 21, activity: { state: 'idle', updatedAt: 10 } })).toMatchObject([{ status: 'failure' }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
