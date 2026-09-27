// The Executor-side session evidence: only a complete structured `native_session`
// payload in Aiur's per-ticket log counts; prose never does.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aiurLogs, nativeSessionFromLog, ticketLog } from '../../../scripts/acceptance/adapters/aiur';

const SESSION = {
  session_id: 'native-7', os_pid: 4242, harness: 'codex', provider: 'openai', model: 'gpt-5.5-codex',
  cli_version: '0.156.1', launch_command: 'codex --model gpt-5.5-codex', started_at: '2026-09-26T10:00:00Z',
};
const line = (payload: unknown, body = 'x') => JSON.stringify({ body, msg_id: 'm', payload, role: 'tool', sequence: 1, timestamp: 't', turn_id: 'u' });

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('Aiur native-session evidence', () => {
  it('reads one complete native_session payload', () => {
    expect(nativeSessionFromLog([line(null), line({ native_session: SESSION })].join('\n'))).toEqual({
      sessionId: 'native-7', pid: 4242, harness: 'codex', provider: 'openai', model: 'gpt-5.5-codex',
      cliVersion: '0.156.1', launchCommand: 'codex --model gpt-5.5-codex', startedAt: '2026-09-26T10:00:00Z',
    });
  });

  it('ignores agent prose, partial records and ambiguous sessions', () => {
    expect(nativeSessionFromLog(line(null, `my session is ${JSON.stringify(SESSION)}`))).toBeNull();
    expect(nativeSessionFromLog(line({ native_session: { ...SESSION, model: undefined } }))).toBeNull();
    expect(nativeSessionFromLog([line({ native_session: SESSION }), line({ native_session: { ...SESSION, session_id: 'native-8' } })].join('\n'))).toBeNull();
  });

  it('finds the newest run log for the ticket in the acceptance repository', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-aiur-'));
    directories.push(root);
    const name = `github-${Buffer.from('aiur-team/khala').toString('base64url')}.1001.agent_events.jsonl`;
    for (const [run, session] of [['20260925T000000Z-1', { ...SESSION, session_id: 'old' }], ['20260926T000000Z-2', SESSION]] as const) {
      fs.mkdirSync(path.join(root, run, 'log'), { recursive: true });
      fs.writeFileSync(path.join(root, run, 'log', name), line({ native_session: session }));
    }
    expect(ticketLog(root, 'aiur-team/khala', 1001)).toBe(path.join(root, '20260926T000000Z-2', 'log', name));
    expect((await aiurLogs(root, 'aiur-team/khala').session(1001))?.sessionId).toBe('native-7');
    expect(await aiurLogs(root, 'aiur-team/khala').session(1002)).toBeNull();
  });
});
